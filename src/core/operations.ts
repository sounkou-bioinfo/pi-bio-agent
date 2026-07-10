import { createHash } from "node:crypto";
import type { BioArtifact } from "./types.js";
import { appendRunEvent, newRunRecord, type BioRunRecord, type BioRunSpec } from "./run-spec.js";
import { validateReadOnlyResultStatement, validateAdHocBioQuerySelect, sqlCallsDynamicSqlAst } from "./sql-guard.js";
import { materializeScaleMembers } from "./scales.js";
import type { BioRegistry, ResolutionReceipt, SourceSnapshot } from "./manifest.js";
import type { CasStore } from "./cas.js";
import type { SqlConn } from "./ports.js";

// Generic execution primitives — the factored, reusable core of what ClawBio writes as a bespoke ~12 KB
// Python program per question. A skill there = parse a format + filter by a rule + write a report + tests.
// Here that is: a resolver (format -> table), an operation (the rule, as declared SQL over the table), and
// this generic runner (resolve -> run -> result + run record + provenance). The question is DATA in a
// manifest; nothing question-specific lives in code. Concrete resolver impls live in adapters/packs/test
// support, never here — core ships contracts and the runner, not implementations.

export interface OperationResult {
  schema: "pi-bio.operation_result.v1";
  operationId: string;
  runId: string;
  sourceSnapshots: SourceSnapshot[];
  rows: Array<Record<string, unknown>>;
}

/**
 * A run that STARTED and then failed at runtime — resolution or the SQL itself (e.g. the binder rejecting a
 * missing column). It carries the failed run record (status "failed") and whatever receipts resolved before
 * the failure, so a host can persist a failed-run receipt instead of losing the failure. Pre-flight/config
 * errors (no sql, resources don't cover requirements) are thrown plainly and are NOT this — the request
 * never became a run. Defends the "reproducible run receipt" gate: a failed run is still auditable.
 */
export class OperationRunError extends Error {
  constructor(message: string, readonly run: BioRunRecord, readonly receipts: ResolutionReceipt[]) {
    super(message);
    this.name = "OperationRunError";
  }
}


/**
 * The general runner: resolve the named resources (materializing their tables), run a read-only SQL query
 * over them, and emit result + run record + provenance. The SQL is the CALLER's, whether authored by a human,
 * model-driven harness, or automation, and is commonly written
 * live after schema discovery (`describeTable`). A declared operation is just the special case where the SQL +
 * resources came from a registered, named, tested spec (see `runOperation`); most questions need no declared
 * operation, only declared resources. `now`/`runId` are injected for deterministic receipts.
 */
export async function runQuery(
  registry: BioRegistry,
  conn: SqlConn,
  opts: {
    sql: string;
    resources: string[];
    runId: string;
    now: string;
    params?: readonly unknown[];
    /** Identity for the run/result/provenance. A registered operation passes its id+version; an ad-hoc caller
     *  query defaults to "ad-hoc.query". */
    id?: string;
    version?: string;
    title?: string;
    description?: string;
    /** Cooperative cancellation, forwarded to each resolver's context (e.g. http.get's fetch). */
    signal?: AbortSignal;
    /** CAS mode, forwarded to each resolver's context (byte snapshot + cross-db reuse). */
    cas?: CasStore;
    /** Host-owned cross-db remote-cache isolation scope, forwarded to resolvers. Absent keeps fail-closed
     *  no-cross-db-reuse behavior. */
    remoteCacheScope?: string;
    /** Host-declared protected session variables that ad-hoc agent SQL must not read with getvariable() or enumerate. */
    protectedSessionVariables?: readonly string[];
  },
): Promise<{ result: OperationResult; run: BioRunRecord; receipts: ResolutionReceipt[] }> {
  const { resources, runId, now, params = [], signal, cas, remoteCacheScope } = opts;
  const id = opts.id ?? "ad-hoc.query";
  const isNamed = opts.id !== undefined;
  const safeSql = isNamed
    ? validateReadOnlyResultStatement(opts.sql)
    : validateAdHocBioQuerySelect(opts.sql, { protectedVariables: opts.protectedSessionVariables });
  // Defense-in-depth over the string guard: re-check the dynamic-SQL executors (query()/query_table()) via DuckDB's
  // OWN parser (json_serialize_sql), which normalizes quoted/qualified spellings a string scan can miss. Pre-flight
  // (a config error, not a failed run) — a pure parse with no side effects on the fresh run conn.
  if (await sqlCallsDynamicSqlAst(conn, safeSql)) throw new Error("query contains a dynamic-SQL table function (query()/query_table()) — forbidden");

  // Pre-flight: the request must be RUNNABLE before it becomes a run — every named resource is registered and
  // its resolver has a bound impl. These are config errors (thrown plainly, NOT failed runs). Runtime failures
  // (a resolver that errors, or the SQL) happen below, after the run has started, and ARE recorded as failed.
  const seenResources = new Set<string>();
  for (const rid of resources) {
    if (seenResources.has(rid)) throw new Error(`query '${id}' lists duplicate resource '${rid}'; declare distinct resource ids for distinct executions`);
    seenResources.add(rid);
    const resource = registry.getResource(rid);
    if (!resource) throw new Error(`query '${id}' requires unregistered resource '${rid}'`);
    if (!registry.hasResolverImpl(resource.resolver)) throw new Error(`resolver '${resource.resolver}' is declared but no implementation is bound`);
  }

  const runSpec: BioRunSpec = { schema: "pi-bio.run_spec.v1", id: runId, title: opts.title ?? "ad-hoc query", description: opts.description ?? "Read-only query over resolved resources.", tool: { name: id, version: opts.version ?? "0.1.0" }, mode: "inline", inputs: [] };
  let run = newRunRecord(runSpec, now);
  run = appendRunEvent(run, { type: "started", at: now });

  const receipts: ResolutionReceipt[] = [];
  try {
    for (const rid of resources) {
      receipts.push(await registry.resolveResource(rid, { conn, now, signal, cas, remoteCacheScope }));
    }
    // Ordinal scales as data: project every ordered TermSet into `scale_members` so the SQL can JOIN and
    // threshold/ORDER BY on rank. Derived from declared manifest data (no external source, no receipt).
    await materializeScaleMembers(registry, conn);

    // No column pre-declaration: caller-authored SQL references its columns, and DuckDB's binder is the
    // arbiter — a missing column fails closed here with a clear binder error. Schema discovery (describeTable)
    // is a primitive the caller uses to decide what SQL to write, not a contract the runner enforces.
    const rows = await conn.all<Record<string, unknown>>(safeSql, params);
    const sourceSnapshots = receipts.flatMap((r) => r.sourceSnapshots);
    const result: OperationResult = { schema: "pi-bio.operation_result.v1", operationId: id, runId, sourceSnapshots, rows };

    // The result IS the report: whatever the SQL returns. Reproducibility pin: the run record carries the
    // identity + version + a digest of the exact query that produced this result — the validated SQL AND its
    // bound params, since different params give different answers and must be a distinguishable receipt.
    const queryDigest = `sha256:${createHash("sha256").update(`${safeSql}\0${JSON.stringify(params)}`).digest("hex")}`;
    const artifact: BioArtifact = {
      kind: "artifact",
      role: "output",
      // Host persists the result as result.json; the run record must point at the file that exists on disk.
      path: `runs/${runId}/result.json`,
      format: "json",
      provenance: [
        { source: id, version: opts.version, digest: queryDigest, notes: [isNamed ? "operation" : "query"] },
        ...receipts.map((r) => ({ source: `${r.resolverId}@${r.resolverVersion}`, retrievedAt: r.resolvedAt, notes: ["resolver receipt"] })),
      ],
    };
    run = appendRunEvent(run, { type: "artifact", at: now, artifacts: [artifact] });
    run = appendRunEvent(run, { type: "completed", at: now, data: { rowCount: rows.length } });
    return { result, run, receipts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run = appendRunEvent(run, { type: signal?.aborted ? "cancelled" : "failed", at: now, message });
    run = { ...run, error: message };
    throw new OperationRunError(message, run, receipts);
  }
}

/**
 * Run a *declared* operation — a named, versioned, tested query that earned a spec (subtle/reused/safety-
 * critical, like the abstention flagship). It is just `runQuery` with the SQL + resources taken from the
 * registered spec. For everything else, the caller writes SQL live and calls `runQuery` directly; a manifest
 * needs to declare only its resources, not an operation per question.
 */
export async function runOperation(
  registry: BioRegistry,
  conn: SqlConn,
  opts: { operationId: string; resources?: string[]; params?: readonly unknown[]; runId: string; now: string; signal?: AbortSignal; cas?: CasStore; remoteCacheScope?: string },
): Promise<{ result: OperationResult; run: BioRunRecord; receipts: ResolutionReceipt[] }> {
  const { operationId } = opts;
  const op = registry.getOperation(operationId);
  if (!op?.sql) throw new Error(`operation '${operationId}' has no duckdb.sql request`);

  const declared = op.sql.requiredResources ?? [];
  const resources = opts.resources ?? declared;
  if (opts.resources) {
    const have = new Set(opts.resources);
    const uncovered = declared.filter((d) => !have.has(d));
    if (uncovered.length) throw new Error(`operation '${operationId}': provided resources do not cover required resource(s): ${uncovered.join(", ")}`);
  }
  return runQuery(registry, conn, {
    sql: op.sql.sqlTemplate, resources, runId: opts.runId, now: opts.now, params: opts.params, signal: opts.signal, cas: opts.cas, remoteCacheScope: opts.remoteCacheScope,
    id: op.id, version: op.version, title: op.title, description: op.description,
  });
}
