import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { SqlConn } from "../core/ports.js";
import type { CasStore } from "../core/cas.js";
import { createBioObservationSchema, observationAsOfKey, recordMonotonicObservation } from "../duckdb/observations.js";
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
  // INJECTIVE typed encoding so distinct types can never collide in the digest. JSON already separates
  // number/boolean/null/array/object, but (a) bigint isn't JSON-serializable (JSON.stringify THROWS on it — a DuckDB
  // BIGINT binding would crash the digest + the run-object CAS write) and (b) a naive string tag for bigint could
  // collide with a real string of that exact text. So tag BOTH strings and bigints: a bigint becomes
  // {__t:"bigint",v} with RAW inner strings, while every real string becomes {__t:"string",v}. A user value can
  // therefore never reproduce the bigint form — its own inner strings would themselves be tagged. Objects/arrays
  // recurse; number/boolean/null stay native (already JSON-distinct).
  if (typeof v === "bigint") return { __t: "bigint", v: v.toString() };
  if (typeof v === "string") return { __t: "string", v };
  // Non-finite numbers (NaN/±Infinity) would be coerced to `null` by JSON.stringify — colliding NaN, Infinity, and a
  // real null under one key. Tag them (finite numbers stay native, already JSON-distinct).
  if (typeof v === "number") return Number.isFinite(v) ? v : { __t: "number", v: String(v) };
  // `undefined` as an object field is DROPPED by JSON.stringify, so {a:undefined,b:1} would collide with {b:1}. Tag it.
  if (v === undefined) return { __t: "undefined" };
  // functions/symbols aren't JSON values and would silently vanish/mis-encode — a non-JSON input must fail closed.
  if (typeof v === "function" || typeof v === "symbol") throw new Error(`actionInputDigest: replay contains a ${typeof v}; inputs must be JSON-serializable values`);
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") {
    // Plain objects only. A non-plain object (Date, Map, class instance) has no meaningful own-key projection here —
    // Object.keys(new Date()) is [], so every Date would collapse to {} and collide. Replay inputs come from JSON
    // tool params (plain values); reject a non-plain object rather than silently mis-key it. Fail closed.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`actionInputDigest: replay contains a non-plain object (${proto?.constructor?.name ?? "unknown"}); inputs must be JSON-serializable (plain objects/arrays/primitives)`);
    }
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function actionInputDigest(replay: Pick<RunReplaySpec, "kind" | "manifest" | "operationId" | "sql" | "resources" | "bindings" | "sourceReceiptDigests" | "duckdbInitSqlDigest" | "protectedSessionBindingsDigest" | "protectedSessionVariablesDigest" | "duckdbConfigDigest" | "process" | "environment">): string {
  const canonical = JSON.stringify(canonicalize([
    replay.kind,
    replay.manifest?.digest ?? null,
    replay.operationId ?? null,
    replay.sql ?? null,
    replay.resources ?? null, // EXECUTION ORDER preserved (NOT sorted): resources resolve in caller order and each
                              // resolver CREATE-OR-REPLACEs its table, so [A,B] and [B,A] can yield different DB state
                              // -> different result. Sorting would collide them under one key and serve a wrong hit.
    replay.bindings ?? null, // canonicalize() sorts its keys so binding order doesn't change the CASID
    replay.sourceReceiptDigests ?? null, // resolved-content refs, in resolution order (matches `resources`) -> the key captures the input DAG AND the order it was built in
    // RESULT-AFFECTING execution facts — omitting these would collide runs that produce DIFFERENT results and let
    // the ActionCache/recallRunResult serve the WRONG cached result:
    replay.duckdbInitSqlDigest ?? null,  // digest of the init SQL (SET/LOAD/ATTACH change the result); same SQL -> same digest -> same key
    replay.protectedSessionBindingsDigest ?? null, // host-owned protected session values can change declared-op results; digest only, never the values
    replay.protectedSessionVariablesDigest ?? null, // protected-name declarations change the ad-hoc guard surface; pin the boundary
    replay.duckdbConfigDigest ?? null,   // DuckDB config (extensions/secrets/dirs) can change the result
    replay.process ?? null,              // process.compute command/inputSql/outputs are the computation itself
    replay.environment ?? null,          // a different attested environment can yield a different result
  ]));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Look up the output (result) CASID an earlier identical run produced — the memo/dedup hit. null on a miss. */
export async function actionCacheGet(conn: SqlConn, inputDigest: string, asOf: string = FUTURE): Promise<string | null> {
  // A fresh store may not have the ledger table yet; recall on it is a MISS, not a throw. Ensure it (idempotent) so
  // the SELECT below can't fail on a missing table — a not-yet-populated cache legitimately returns null.
  await createBioObservationSchema(conn, { ifNotExists: true });
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
  await createBioObservationSchema(conn, { ifNotExists: true }); // a fresh store may lack the table; put must not be swallowed by run-store's best-effort memoization
  const key = actionKey(inputDigest);
  // strictly-monotonic recordedAt per action slot (state machine), SERIALIZED per key: two puts for one inputDigest
  // with DIFFERENT outputs — even concurrent, same-ms — must not be tie-broken by hash-arbitrary observation_id (that
  // could serve the OLDER output). recordMonotonicObservation advances + writes under a per-slot lock so the later
  // write deterministically wins (it IS the current mapping).
  await recordMonotonicObservation(conn, { statementKey: key, subjectId: key, predicate: "action_output", value: { output: outputDigest }, source: author, digest: inputDigest }, now, FUTURE);
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
  // (duckdbInitSqlDigest/protectedSession*Digest/duckdbConfigDigest/process/environment) would compute a WEAKER recall key than the one the
  // run was stored under, so a caller's minimal replay could collide with a simpler run and serve its wrong rows.
  // (`resultDigest` is NOT part of the input key — it's the run's RECORDED output, used below to fail closed on a
  // memo that has since diverged.)
  replay: Pick<RunReplaySpec, "kind" | "manifest" | "operationId" | "sql" | "resources" | "bindings" | "sourceReceiptDigests" | "duckdbInitSqlDigest" | "protectedSessionBindingsDigest" | "protectedSessionVariablesDigest" | "duckdbConfigDigest" | "process" | "environment" | "resultDigest">,
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
  // TOCTOU: GC can delete the bytes BETWEEN has() and the read. An ENOENT here is the same "evicted" case, so it is a
  // MISS (re-run), not a thrown error — fail closed to the miss. Other read errors (permissions, I/O) still propagate.
  let text: string;
  try {
    text = await fs.readFile(cas.pathFor(address), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const rows = JSON.parse(text) as unknown[];
  return { rows, resultDigest: outputDigest };
}
