import type { BioArtifact } from "./types.js";
import { appendRunEvent, newRunRecord, type BioRunRecord, type BioRunSpec } from "./run-spec.js";
import { validateReadOnlySelect } from "./sql-guard.js";
import { describeTable } from "./schema-discovery.js";
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

/** Stable, auditable report over a bucketed classification result — derived when the operation declares `report`. */
export interface BucketedOperationReport {
  schema: "pi-bio.bucketed_operation_report.v1";
  operationId: string;
  runId: string;
  countsByBucket: Record<string, number>;
  included: number;
  excluded: number;
  caveats: string[];
  rows: Array<{ id: unknown; bucket: unknown }>;
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
): Promise<{ result: OperationResult; report?: BucketedOperationReport; run: BioRunRecord; receipts: ResolutionReceipt[] }> {
  const { operationId, resources = [], params = [], runId, now } = opts;
  const op = registry.getOperation(operationId);
  if (!op?.sql) throw new Error(`operation '${operationId}' has no duckdb.sql request`);
  validateReadOnlySelect(op.sql.sqlTemplate); // declared read-only is enforced before we touch the conn

  const receipts: ResolutionReceipt[] = [];
  for (const rid of resources) {
    if (!registry.getResource(rid)) throw new Error(`operation '${operationId}' requires unregistered resource '${rid}'`);
    receipts.push(await registry.resolveResource(rid, { conn, now }));
  }

  // Schema discovery, not pre-declared table types: the operation declares the few columns it needs; we
  // discover what the resolved inputs actually produced and fail closed (clearly) before binding the SQL.
  if (op.sql.requiredColumns?.length && receipts.length) {
    const present = new Set<string>();
    for (const r of receipts) {
      if (r.result.name) for (const c of await describeTable(conn, r.result.name)) present.add(c.name);
    }
    const missing = op.sql.requiredColumns.filter((c) => !present.has(c));
    if (missing.length) throw new Error(`operation '${operationId}' requires column(s) not found in resolved inputs: ${missing.join(", ")}`);
  }

  const rows = await conn.all<Record<string, unknown>>(op.sql.sqlTemplate, params);
  const sourceSnapshots = receipts.flatMap((r) => r.sourceSnapshots);
  const result: OperationResult = { schema: "pi-bio.operation_result.v1", operationId, runId, sourceSnapshots, rows };

  let report: BucketedOperationReport | undefined;
  if (op.report) {
    const { idColumn, bucketColumn, includedBucket, caveats = [] } = op.report;
    const reportRows = rows.map((r) => ({ id: r[idColumn], bucket: r[bucketColumn] }));
    const countsByBucket: Record<string, number> = {};
    for (const r of reportRows) countsByBucket[String(r.bucket)] = (countsByBucket[String(r.bucket)] ?? 0) + 1;
    const included = countsByBucket[includedBucket] ?? 0;
    report = { schema: "pi-bio.bucketed_operation_report.v1", operationId, runId, countsByBucket, included, excluded: rows.length - included, caveats, rows: reportRows };
  }

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

  return { result, report, run, receipts };
}
