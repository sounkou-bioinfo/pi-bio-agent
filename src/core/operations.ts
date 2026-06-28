import type { BioArtifact } from "./types.js";
import { appendRunEvent, newRunRecord, type BioRunRecord, type BioRunSpec } from "./run-spec.js";
import { validateReadOnlySelect } from "./sql-guard.js";
import type { BioRegistry, ResolutionReceipt, SourceSnapshot, SqlConn } from "./manifest.js";

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
 * Generic operation runner: resolve the named required resources (materializing their tables/views), run
 * the operation's declared SQL, and emit result + run record + provenance. No question logic here — that is
 * the operation's SQL and the registered data. This is ClawBio's uniform `run(input) -> result`, factored
 * once. `now`/`runId` are injected for deterministic receipts/records.
 */
export async function runOperation(
  registry: BioRegistry,
  conn: SqlConn,
  opts: { operationId: string; resources?: string[]; params?: readonly unknown[]; runId: string; now: string },
): Promise<{ result: OperationResult; run: BioRunRecord; receipts: ResolutionReceipt[] }> {
  const { operationId, params = [], runId, now } = opts;
  const op = registry.getOperation(operationId);
  if (!op?.sql) throw new Error(`operation '${operationId}' has no duckdb.sql request`);
  validateReadOnlySelect(op.sql.sqlTemplate); // declared read-only is enforced before we touch the conn

  // The operation declares the resources it needs. Derive them when the caller omits an explicit list;
  // when a list is given, it must cover the declared requirements (fail closed, not a deep SQL binder error).
  const declared = op.sql.requiredResources ?? [];
  const resources = opts.resources ?? declared;
  if (opts.resources) {
    const have = new Set(opts.resources);
    const uncovered = declared.filter((d) => !have.has(d));
    if (uncovered.length) throw new Error(`operation '${operationId}': provided resources do not cover required resource(s): ${uncovered.join(", ")}`);
  }

  const receipts: ResolutionReceipt[] = [];
  for (const rid of resources) {
    if (!registry.getResource(rid)) throw new Error(`operation '${operationId}' requires unregistered resource '${rid}'`);
    receipts.push(await registry.resolveResource(rid, { conn, now }));
  }

  // No column pre-declaration: the SQL the agent wrote references its columns, and DuckDB's binder is the
  // arbiter — a missing column fails closed here with a clear binder error. Schema discovery (describeTable)
  // is a primitive the agent CALLS to decide what SQL to write, not a contract the runner enforces.
  const rows = await conn.all<Record<string, unknown>>(op.sql.sqlTemplate, params);
  const sourceSnapshots = receipts.flatMap((r) => r.sourceSnapshots);
  const result: OperationResult = { schema: "pi-bio.operation_result.v1", operationId, runId, sourceSnapshots, rows };

  // The result IS the report: whatever the operation's SQL returns (classified rows, or a GROUP BY count).
  // No TS reducer, no report-kind taxonomy — counts/aggregation are the operation's SQL when it wants them.
  const artifact: BioArtifact = {
    kind: "artifact",
    role: "output",
    path: `runs/${runId}/${operationId}.json`,
    format: "json",
    provenance: [
      { source: op.id, notes: ["operation"] },
      ...receipts.map((r) => ({ source: `${r.resolverId}@${r.resolverVersion}`, retrievedAt: r.resolvedAt, notes: ["resolver receipt"] })),
    ],
  };
  const runSpec: BioRunSpec = { schema: "pi-bio.run_spec.v1", id: runId, title: op.title, description: op.description, tool: { name: op.id, version: op.version }, mode: "inline", inputs: [] };
  let run = newRunRecord(runSpec, now);
  run = appendRunEvent(run, { type: "started", at: now });
  run = appendRunEvent(run, { type: "artifact", at: now, artifacts: [artifact] });
  run = appendRunEvent(run, { type: "completed", at: now, data: { rowCount: rows.length } });

  return { result, run, receipts };
}
