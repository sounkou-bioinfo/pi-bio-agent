import { createHash } from "node:crypto";
import type { SqlConn } from "../core/ports.js";
import { observationAsOfKey, recordObservation } from "../duckdb/observations.js";
import type { RunReplaySpec } from "../core/reproducibility.js";

// LLVM CAS ActionCache, in the ONE store: a key/value map from an INPUT CASID (the digest of a computation's
// reproducible inputs) to an OUTPUT CASID (the result's content address in CAS). It memoizes runs — "have we
// already computed this exact input, and where is the result?" — which is dedup, Fugu's avoid-redundant-repeat,
// and the basis of reproduce() (re-run + compare the output CASID). Stored as observations, so it is as-of and
// shareable like every other fact; the RESULT BYTES stay in CAS, outside the DB (only the digest lives here).
const FUTURE = "9999-12-31T23:59:59.999Z";
const actionKey = (inputDigest: string): string => `action:${inputDigest}`;

/**
 * The ACTION KEY: a content digest over a run's REPRODUCIBLE inputs — kind, manifest digest, operation/SQL,
 * resources, bindings. Volatile bits (runId, timestamps) are excluded, so identical inputs across runs/projects
 * produce the same key. This is the CASID of the computation's input DAG.
 */
export function actionInputDigest(replay: Pick<RunReplaySpec, "kind" | "manifest" | "operationId" | "sql" | "resources" | "bindings">): string {
  const canonical = JSON.stringify([
    replay.kind,
    replay.manifest?.digest ?? null,
    replay.operationId ?? null,
    replay.sql ?? null,
    [...(replay.resources ?? [])].sort(),
    replay.bindings ?? null,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Look up the output (result) CASID an earlier identical run produced — the memo/dedup hit. null on a miss. */
export async function actionCacheGet(conn: SqlConn, inputDigest: string, asOf: string = FUTURE): Promise<string | null> {
  const row = await observationAsOfKey(conn, actionKey(inputDigest), asOf);
  if (!row || row.value_json == null) return null;
  return (JSON.parse(row.value_json) as { output?: string }).output ?? null;
}

/**
 * Record input → output: this exact input now maps to this result CASID, attributed to `author`. Append-only —
 * a later identical input whose output DIFFERS supersedes the mapping, and that divergence is itself the signal
 * reproduce() surfaces (a computation that stopped being deterministic).
 */
export async function actionCachePut(conn: SqlConn, inputDigest: string, outputDigest: string, now: string, author?: string): Promise<void> {
  const key = actionKey(inputDigest);
  await recordObservation(conn, { statementKey: key, subjectId: key, predicate: "action_output", value: { output: outputDigest }, recordedAt: now, source: author, digest: inputDigest });
}
