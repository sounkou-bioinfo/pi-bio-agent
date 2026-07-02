import { randomBytes } from "node:crypto";
import type { SqlConn } from "../core/ports.js";

// Chunked HTTP fanout over ducknng's ASYNC client — host code for the MANY-endpoints / chunk case. The dynamic-
// schema `ducknng_ncurl_table` can't be lateral-correlated per chunk, so a per-chunk fanout needs the scalar aio
// loop below. (The SINGLE-endpoint retry is now a different story: on the OWNED ducknng build `ducknng_ncurl` is
// VOLATILE and a recursive CTE re-fires per iteration — see ncurl-retry.ts; on the default community build it
// still constant-folds, so even single-endpoint retry falls back to a host loop there.) The SCALAR launcher
// `ducknng_ncurl_aio(url, …)` DOES
// take a per-row column body, so one statement launches one real request per batch; the DRAIN
// (`ducknng_ncurl_aio_collect`, an any-ready collector — NOT a wait-for-all barrier) and the status-driven
// RE-LAUNCH (retry) are the loop. Errors are values here: `aio_collect` returns (ok, status, …) rows, so a
// retry decision is a `WHERE` over `status`, never an exception. That loop is what this function is.
//
// Contract:
//   in   `batchesTable`  : (batch_id BIGINT, body VARCHAR) — one HTTP request per row, body is the request body
//   out  `resultsTable`  : (batch_id BIGINT, status INTEGER, body_text VARCHAR) — one row per batch that
//                          succeeded (2xx). Terminal failures (permanent status, or transient exhausted after
//                          maxRounds) are NOT here; they are returned in `failures` with their last status.
// The host owns url/method/headers/tls (composed in, never agent params); the data args are parameter-bound.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// batch_id comes back from DuckDB as BIGINT; coercing to a JS number is only safe below 2^53. Guard it so a
// huge id can never silently target the wrong row in a DELETE/UPDATE IN-list. (batch_id is a chunk index, so
// this never fires in practice — but it must not be a silent footgun.)
const safeId = (v: bigint): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`ncurlFanout: batch_id ${v} exceeds JS safe-integer range`);
  return n;
};

export interface NcurlFanoutOptions {
  /** input table (batch_id, body) — one request per row */
  batchesTable: string;
  /** output table to create (batch_id, status, body_text) — one row per ultimately-successful (2xx) batch */
  resultsTable: string;
  url: string;
  /** ducknng canonical header array, e.g. '[{"name":"Content-Type","value":"application/json"}]' */
  headersJson: string;
  method?: string; // default POST
  /** tls_config_id (bound, not interpolated). Host-owned. Default 0 (no TLS / plain http). */
  tlsConfigId?: number;
  timeoutMs?: number; // per request; default 60000
  /** max in-flight requests per wave — caps concurrency so a whole-chromosome fanout doesn't flood the API.
   *  Default 8. Set higher only against an endpoint you know tolerates it. */
  maxInFlight?: number;
  maxRounds?: number; // max attempts per batch (transient retries); default 6
  drainWaitMs?: number; // per aio_collect wait; default 3000
  drainSpins?: number; // safety cap on drain iterations per wave; default 200
  backoffMs?: number; // initial inter-wave backoff when transient retries remain; default 500
  maxBackoffMs?: number; // default 8000
  /** Which outcomes are TRANSIENT (worth retrying). Default: transport failure (ok=false) or 429 or any 5xx.
   *  A permanent status (e.g. 400/404) is NOT retried — it terminates immediately. */
  isTransient?: (status: number | null, ok: boolean) => boolean;
}

export interface NcurlFanoutResult {
  waves: number;
  succeeded: number;
  failures: Array<{ batchId: number; status: number | null; transient: boolean }>;
}

const defaultTransient = (status: number | null, ok: boolean): boolean => !ok || status === 429 || (status !== null && status >= 500);

/**
 * Launch one ducknng async HTTP request per row of `batchesTable`, in concurrency-capped WAVES; drain each wave
 * to completion (looping the any-ready collector — never a single collect); record 2xx in `resultsTable`; retry
 * only TRANSIENT failures with exponential backoff up to `maxRounds` attempts; terminate PERMANENT failures
 * immediately. Every launched handle is dropped (collected) or cancelled+dropped (drain-cap) — no leak, and an
 * abandoned in-flight handle is never left racing a relaunch. ducknng must already be LOADed on `conn`.
 */
export async function ncurlFanout(conn: SqlConn, opts: NcurlFanoutOptions): Promise<NcurlFanoutResult> {
  const { batchesTable, resultsTable, url, headersJson } = opts;
  for (const [label, id] of [["batchesTable", batchesTable], ["resultsTable", resultsTable]] as const) {
    if (!IDENT.test(id)) throw new Error(`ncurlFanout: ${label} '${id}' must be a SQL identifier`);
  }
  const method = opts.method ?? "POST";
  const tlsConfigId = opts.tlsConfigId ?? 0;
  if (!Number.isInteger(tlsConfigId) || tlsConfigId < 0) throw new Error("ncurlFanout: tlsConfigId must be a non-negative integer");
  const timeoutMs = opts.timeoutMs ?? 60000;
  const maxInFlight = opts.maxInFlight ?? 8;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new Error("ncurlFanout: maxInFlight must be a positive integer"); // LIMIT 0 would launch nothing and spin forever
  const maxRounds = opts.maxRounds ?? 6;
  const drainWaitMs = opts.drainWaitMs ?? 3000;
  const drainSpins = opts.drainSpins ?? 200;
  const maxBackoffMs = opts.maxBackoffMs ?? 8000;
  const isTransient = opts.isTransient ?? defaultTransient;

  // queue carries each batch's remaining attempts; wave/launched/collected are per-wave scratch. A per-call random
  // token keeps these INTERNAL names from clobbering a caller's own table (e.g. an existing `out__queue`) — they are
  // created, used, and dropped entirely within this call and never referenced by the caller.
  const tok = randomBytes(4).toString("hex");
  const queue = `${resultsTable}__queue_${tok}`;
  const wave = `${resultsTable}__wave_${tok}`;
  const launched = `${resultsTable}__launched_${tok}`;
  const collected = `${resultsTable}__collected_${tok}`;
  await conn.run(`CREATE OR REPLACE TABLE ${resultsTable} (batch_id BIGINT, status INTEGER, body_text VARCHAR)`);
  await conn.run(`CREATE OR REPLACE TABLE ${queue} AS SELECT batch_id, body, ${maxRounds}::INTEGER AS attempts_left FROM ${batchesTable}`);

  const failures: NcurlFanoutResult["failures"] = [];
  let waves = 0;
  let backoff = opts.backoffMs ?? 500;
  for (;;) {
    const [{ q }] = await conn.all<{ q: bigint }>(`SELECT count(*) q FROM ${queue}`);
    if (Number(q) === 0) break;
    waves += 1;

    // take a concurrency-capped wave and launch one async request per row (scalar launcher, per-row column body)
    await conn.run(`CREATE OR REPLACE TABLE ${wave} AS SELECT batch_id, body, attempts_left FROM ${queue} ORDER BY batch_id LIMIT ${maxInFlight}`);
    await conn.run(
      `CREATE OR REPLACE TABLE ${launched} AS
       SELECT batch_id, ducknng_ncurl_aio(?, ?, ?, body::BLOB, ?, ?::UBIGINT) AS h FROM ${wave}`,
      [url, method, headersJson, timeoutMs, tlsConfigId],
    );
    await conn.run(`CREATE OR REPLACE TABLE ${collected} (aio_id UBIGINT, ok BOOLEAN, status INTEGER, body_text VARCHAR)`);
    const [{ need }] = await conn.all<{ need: bigint }>(`SELECT count(*) need FROM ${launched}`);

    // drain until every launched handle of THIS wave is terminal (loop the any-ready collector)
    let got = 0;
    for (let spin = 0; got < Number(need) && spin < drainSpins; spin += 1) {
      await conn.run(
        `INSERT INTO ${collected}
         SELECT aio_id, ok, status, body_text
         FROM ducknng_ncurl_aio_collect((SELECT list(h) FROM ${launched} WHERE h NOT IN (SELECT aio_id FROM ${collected})), ?)`,
        [drainWaitMs],
      );
      const [{ n }] = await conn.all<{ n: bigint }>(`SELECT count(*) n FROM ${collected}`);
      got = Number(n);
    }

    // 2xx successes -> results
    await conn.run(
      `INSERT INTO ${resultsTable}
       SELECT l.batch_id, c.status, c.body_text
       FROM ${launched} l JOIN ${collected} c ON c.aio_id = l.h
       WHERE c.ok AND c.status BETWEEN 200 AND 299`,
    );
    // outcomes per batch for this wave: collected non-2xx (with ok/status) + any UNcollected (drain-cap) = transport-fail
    const outcomes = await conn.all<{ batch_id: bigint; ok: boolean | null; status: number | null; attempts_left: number }>(
      `SELECT w.batch_id, c.ok, c.status, w.attempts_left
       FROM ${wave} w
       LEFT JOIN ${launched} l ON l.batch_id = w.batch_id
       LEFT JOIN ${collected} c ON c.aio_id = l.h
       WHERE NOT (c.ok AND c.status BETWEEN 200 AND 299) OR c.aio_id IS NULL`,
    );
    // release EVERY launched handle: collected ones drop cleanly; uncollected (still in-flight at the cap) are
    // cancelled then dropped so they never leak NOR race the relaunch.
    await conn.run(`SELECT ducknng_aio_drop(aio_id) FROM ${collected}`);
    await conn.run(`SELECT ducknng_aio_cancel(h) FROM ${launched} WHERE h NOT IN (SELECT aio_id FROM ${collected})`);
    await conn.run(`SELECT ducknng_aio_drop(h) FROM ${launched} WHERE h NOT IN (SELECT aio_id FROM ${collected})`);

    // classify: permanent -> terminal failure; transient with attempts left -> requeue (attempts-1); exhausted -> failure
    const requeue: number[] = [];
    for (const o of outcomes) {
      const id = safeId(o.batch_id);
      const ok = o.ok === true; // uncollected -> null -> treated as transport failure (transient)
      const transient = isTransient(o.status, ok);
      if (!transient) { failures.push({ batchId: id, status: o.status, transient: false }); continue; }
      if (o.attempts_left - 1 <= 0) { failures.push({ batchId: id, status: o.status, transient: true }); continue; }
      requeue.push(id);
    }
    // queue update: THIS WAVE's terminal batches (succeeded / permanent-failed / transient-exhausted) leave the
    // queue; transient-retriable ones stay with one fewer attempt. Batches BEYOND maxInFlight were never in this
    // wave and are left untouched, so a later wave picks them up. (Bug guard: do NOT rebuild the queue from the
    // wave alone — that would drop every not-yet-launched batch.)
    const waveIds = (await conn.all<{ batch_id: bigint }>(`SELECT batch_id FROM ${wave}`)).map((r) => safeId(r.batch_id));
    const requeueSet = new Set(requeue);
    const terminal = waveIds.filter((id) => !requeueSet.has(id));
    if (terminal.length) await conn.run(`DELETE FROM ${queue} WHERE batch_id IN (${terminal.join(",")})`);
    if (requeue.length) await conn.run(`UPDATE ${queue} SET attempts_left = attempts_left - 1 WHERE batch_id IN (${requeue.join(",")})`);
    if (requeue.length > 0) { await sleep(backoff); backoff = Math.min(backoff * 2, maxBackoffMs); }
  }

  const [{ succeeded }] = await conn.all<{ succeeded: bigint }>(`SELECT count(*) succeeded FROM ${resultsTable}`);
  for (const t of [queue, wave, launched, collected]) await conn.run(`DROP TABLE IF EXISTS ${t}`);
  return { waves, succeeded: Number(succeeded), failures };
}
