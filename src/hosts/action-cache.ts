import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { SqlConn } from "../core/ports.js";
import type { CasStore } from "../core/cas.js";
import { observationAsOfKey, recordObservation, monotonicRecordedAt } from "../duckdb/observations.js";
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
 * resources, bindings, AND `sourceReceiptDigests` (the digests of the RESOLVED input content). Volatile bits
 * (runId, timestamps) are excluded. Including the resolved-content digests is what makes this a true LLVM-style
 * input CASID: two runs whose declaration matches but whose SOURCE CONTENT differs (a changed file, a live
 * endpoint) get DIFFERENT keys — so a cache hit can never serve a stale result. Pass the ENRICHED replay (the one
 * carrying sourceReceiptDigests); before resolution those digests are absent and the key is content-blind.
 */
// Recursively sort object keys so semantically identical values hash identically regardless of insertion order
// (agent bindings are an object whose key order is not meaningful — different order must not miss the cache).
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function actionInputDigest(replay: Pick<RunReplaySpec, "kind" | "manifest" | "operationId" | "sql" | "resources" | "bindings" | "sourceReceiptDigests" | "duckdbInitSqlDigest" | "duckdbConfigDigest" | "process" | "environment">): string {
  const canonical = JSON.stringify(canonicalize([
    replay.kind,
    replay.manifest?.digest ?? null,
    replay.operationId ?? null,
    replay.sql ?? null,
    [...(replay.resources ?? [])].sort(),
    replay.bindings ?? null, // canonicalize() sorts its keys so binding order doesn't change the CASID
    [...(replay.sourceReceiptDigests ?? [])].sort(), // resolved-content refs -> key captures the input DAG, not just the declaration
    // RESULT-AFFECTING execution facts — omitting these would collide runs that produce DIFFERENT results and let
    // the ActionCache/recallRunResult serve the WRONG cached result:
    replay.duckdbInitSqlDigest ?? null,  // digest of the init SQL (SET/LOAD/ATTACH change the result); same SQL -> same digest -> same key
    replay.duckdbConfigDigest ?? null,   // DuckDB config (extensions/secrets/dirs) can change the result
    replay.process ?? null,              // process.compute command/inputSql/outputs are the computation itself
    replay.environment ?? null,          // a different attested environment can yield a different result
  ]));
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
  // strictly-monotonic recordedAt per action slot (state machine): two same-ms puts for one inputDigest with
  // DIFFERENT outputs would otherwise be tie-broken by hash-arbitrary observation_id, so actionCacheGet/recallRunResult
  // could serve the OLDER output. Advance so the later write deterministically wins (it IS the current mapping).
  const at = await monotonicRecordedAt(conn, key, now, FUTURE);
  await recordObservation(conn, { statementKey: key, subjectId: key, predicate: "action_output", value: { output: outputDigest }, recordedAt: at, source: author, digest: inputDigest });
}

/**
 * The memoized SKIP made safe + useful: recall a run's RESULT by its recorded inputs, WITHOUT re-executing. Given
 * a prior run's (enriched) replay — which already carries `sourceReceiptDigests`, so the input CASID is computable
 * with NO re-resolution — look up the ActionCache and, on a hit, fetch the result rows straight from CAS by the
 * output digest. Returns null on a miss. This is why the ActionCache key had to be content-addressed AND why a run
 * with a LIVE SOURCE (whose sourceReceiptDigests are blind to the source content) is NOT memoized at put time
 * (run-store): so for anything that IS in the cache, an identical input maps to the identical result and a hit can
 * NEVER serve a stale answer. (An auto-skip inside the run path is
 * deliberately NOT baked in: computing the input CASID needs resolution, which is already memoized, so the only
 * saving there is the — usually cheap — SQL. This recall is where the skip actually pays: replaying a recorded run.)
 */
export async function recallRunResult(
  store: SqlConn,
  cas: CasStore,
  // MUST be the SAME field set actionInputDigest keys on — omitting the result-affecting execution facts
  // (duckdbInitSqlDigest/duckdbConfigDigest/process/environment) would compute a WEAKER recall key than the one the
  // run was stored under, so a caller's minimal replay could collide with a simpler run and serve its wrong rows.
  // (`resultDigest` is NOT part of the input key — it's the run's RECORDED output, used below to fail closed on a
  // memo that has since diverged.)
  replay: Pick<RunReplaySpec, "kind" | "manifest" | "operationId" | "sql" | "resources" | "bindings" | "sourceReceiptDigests" | "duckdbInitSqlDigest" | "duckdbConfigDigest" | "process" | "environment" | "resultDigest">,
): Promise<{ rows: unknown[]; resultDigest: string } | null> {
  const outputDigest = await actionCacheGet(store, actionInputDigest(replay));
  if (!outputDigest) return null;
  // DIVERGENCE guard: if this replay pins the run's RECORDED output, the memo must still agree with it. A later
  // identical-input run whose output DIFFERED (a non-deterministic bit not caught by live_source — random()/now() in
  // SQL) supersedes the memo, so recalling THIS run would otherwise silently serve the NEWER run's rows. Fail closed
  // — a diverged memo is a recall MISS; reproduce() is where that non-determinism is meant to surface, not recall.
  if (replay.resultDigest && replay.resultDigest !== outputDigest) return null;
  const address = { algorithm: "sha256" as const, digest: outputDigest.replace(/^sha256:/, "") };
  if (!(await cas.has(address))) return null; // referenced but bytes evicted (e.g. GC) — a miss, re-run instead
  const rows = JSON.parse(await fs.readFile(cas.pathFor(address), "utf8")) as unknown[];
  return { rows, resultDigest: outputDigest };
}
