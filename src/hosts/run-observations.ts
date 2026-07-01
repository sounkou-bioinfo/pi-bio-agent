import type { SqlConn } from "../core/ports.js";
import { recordObservation } from "../duckdb/observations.js";

// Fold a RUN into the ONE store. A run — an ad-hoc query (with its exact SQL) or a declared operation — is
// persisted as files under .pi/bio-agent/runs/, but that is a per-project file trail, not shared temporal memory.
// Recording it ALSO as an observation (`run:<runId>`) makes the tool-call history as-of-queryable and shareable:
// a later agent/workflow can ask "did this already run, and what did it return?" over the same store as facts and
// memory, and skip a redundant repeat — Fugu's inter-workflow shared memory (report §3.2.2), not a file glob.
export interface RunObservation {
  runId: string;
  kind: "query" | "operation";
  identity: string; // the operation id, or "ad-hoc.query"
  status: string; // succeeded | failed | ...
  sql?: string; // the exact SQL, for an ad-hoc query
  resources?: string[];
  error?: string;
  digest?: string; // e.g. a normalized-SQL digest, for dedup / "already ran?" checks
}

/** Record a run as a `run:<runId>` observation in the shared store, attributed to `author`. Best-effort at the
 *  call site (logging to the ledger must never fail the run itself). */
export async function recordRunObservation(conn: SqlConn, run: RunObservation, now: string, author?: string): Promise<void> {
  await recordObservation(conn, {
    statementKey: `run:${run.runId}`,
    subjectId: `run:${run.runId}`,
    predicate: "run",
    value: { kind: run.kind, identity: run.identity, status: run.status, sql: run.sql, resources: run.resources, error: run.error },
    recordedAt: now,
    source: author,
    digest: run.digest,
  });
}
