import type { BioArtifact } from "./types.js";
import { appendRunEvent, newRunRecord, type BioRunRecord, type BioRunSpec } from "./run-spec.js";
import type { BioRegistry, BioResolverImpl, ResolutionReceipt, SourceSnapshot, SqlConn } from "./manifest.js";

// Generic execution primitives — the factored, reusable core of what ClawBio writes as a bespoke ~12 KB
// Python program per question. A skill there = parse a format + filter by a rule + write a report + tests.
// Here that is: a resolver (format -> table), an operation (the rule, as declared SQL over the table), and
// this generic runner (resolve -> run -> result + run record + provenance). The question is DATA in a
// manifest; nothing question-specific lives in code.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The simplest resolver kind: materialize a table from inline rows declared in the resource's `params`.
 * Generic over any inline/fixture data — real resolvers (vcf scan, gnomAD lookup, ...) are other impls of
 * the same `BioResolverImpl` contract. Bound at runtime by a host; never carried in a manifest.
 */
export const inlineTableResolver: BioResolverImpl = async (query, ctx) => {
  const { table, columns, rows } = query as { table: string; columns: Array<{ name: string; type: string }>; rows: Array<Record<string, unknown>> };
  if (!IDENT_RE.test(table) || columns.some((c) => !IDENT_RE.test(c.name) || !IDENT_RE.test(c.type))) {
    throw new Error("inlineTableResolver: table/column/type names must be identifiers");
  }
  const now = ctx.now ?? new Date().toISOString();
  await ctx.conn.run(`CREATE TABLE ${table} (${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
  const names = columns.map((c) => c.name);
  const placeholders = names.map(() => "?").join(", ");
  for (const row of rows) {
    await ctx.conn.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`, names.map((n) => row[n] ?? null));
  }
  return {
    schema: "pi-bio.resolution_receipt.v1",
    resolverId: "inline.table",
    resolverVersion: "0.1.0",
    resolvedAt: now,
    query,
    sourceSnapshots: [{ source: "inline", retrievedAt: now }],
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    provenance: [{ source: "inline.table", retrievedAt: now }],
  };
};

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
  const { operationId, resources = [], params = [], runId, now } = opts;
  const op = registry.getOperation(operationId);
  if (!op?.sql) throw new Error(`operation '${operationId}' has no duckdb.sql request`);

  const receipts: ResolutionReceipt[] = [];
  for (const rid of resources) {
    const spec = registry.getResource(rid);
    if (!spec) throw new Error(`operation '${operationId}' requires unregistered resource '${rid}'`);
    receipts.push(await registry.resolve(spec.resolver, spec.params, { conn, now }));
  }

  const rows = await conn.all<Record<string, unknown>>(op.sql.sqlTemplate, params);
  const sourceSnapshots = receipts.flatMap((r) => r.sourceSnapshots);
  const result: OperationResult = { schema: "pi-bio.operation_result.v1", operationId, runId, sourceSnapshots, rows };

  const artifact: BioArtifact = {
    kind: "artifact",
    role: "report",
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
