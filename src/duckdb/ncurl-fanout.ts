import type { SqlConn } from "../core/ports.js";

// Chunked HTTP fanout over ducknng's ASYNC client — the one piece of the SQL-native HTTP story that is
// legitimately host code, not SQL. The IO TABLE functions (ducknng_ncurl / _ncurl_table) reject correlated
// column args ("only literals") AND a recursive CTE over them is constant-folded to a single call, so a
// per-chunk, retried fanout cannot live in one SELECT. The SCALAR launcher `ducknng_ncurl_aio(url, …)` DOES
// take a per-row column body, so one statement launches one real request per batch; the DRAIN
// (`ducknng_ncurl_aio_collect`, an any-ready collector — NOT a wait-for-all barrier) and the status-driven
// RE-LAUNCH (retry) are the loop. Errors are values here: `aio_collect` returns (ok, status, …) rows, so a
// retry is `WHERE status NOT BETWEEN 200 AND 299`, never an exception. That loop is what this function is.
//
// Contract:
//   in   `batchesTable`  : (batch_id BIGINT, body VARCHAR) — one HTTP request per row, body is the request body
//   out  `resultsTable`  : (batch_id BIGINT, ok BOOLEAN, status INTEGER, body_text VARCHAR) — one row per
//                          batch that ultimately SUCCEEDED (2xx). Batches still failing after maxRounds are
//                          left absent (the caller sees `failed > 0` and which batch_ids are missing).
// The host owns url/method/headers/tls (composed in, never agent params); the data args are parameter-bound.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface NcurlFanoutOptions {
  /** input table (batch_id, body) — one request per row */
  batchesTable: string;
  /** output table to create (batch_id, ok, status, body_text) — one row per ultimately-successful batch */
  resultsTable: string;
  url: string;
  /** ducknng canonical header array, e.g. '[{"name":"Content-Type","value":"application/json"}]' */
  headersJson: string;
  method?: string; // default POST
  /** SQL expression yielding the tls_config_id (host-controlled, NOT an agent param). Default '0::UBIGINT'. */
  tlsExpr?: string;
  timeoutMs?: number; // per request; default 60000
  maxRounds?: number; // retry rounds; default 6
  drainWaitMs?: number; // per aio_collect wait; default 3000
  drainSpins?: number; // safety cap on drain iterations per round; default 200
  backoffMs?: number; // initial inter-round backoff; default 500
  maxBackoffMs?: number; // default 8000
}

export interface NcurlFanoutResult {
  rounds: number;
  succeeded: number;
  failed: number; // batches with no 2xx after maxRounds
}

/**
 * Launch one ducknng async HTTP request per row of `batchesTable`, drain to completion (looping the
 * any-ready collector — never relying on a single collect), and re-launch the non-2xx subset with exponential
 * backoff up to `maxRounds`. Leaves the successes in `resultsTable`. ducknng must already be LOADed on `conn`.
 */
export async function ncurlFanout(conn: SqlConn, opts: NcurlFanoutOptions): Promise<NcurlFanoutResult> {
  const { batchesTable, resultsTable, url, headersJson } = opts;
  for (const [label, id] of [["batchesTable", batchesTable], ["resultsTable", resultsTable]] as const) {
    if (!IDENT.test(id)) throw new Error(`ncurlFanout: ${label} '${id}' must be a SQL identifier`);
  }
  const method = opts.method ?? "POST";
  const tlsExpr = opts.tlsExpr ?? "0::UBIGINT";
  const timeoutMs = opts.timeoutMs ?? 60000;
  const maxRounds = opts.maxRounds ?? 6;
  const drainWaitMs = opts.drainWaitMs ?? 3000;
  const drainSpins = opts.drainSpins ?? 200;
  const maxBackoffMs = opts.maxBackoffMs ?? 8000;

  // internal temp tables, namespaced under the result table so concurrent fanouts don't collide
  const launched = `${resultsTable}__launched`;
  const collected = `${resultsTable}__collected`;
  const pending = `${resultsTable}__pending`;

  await conn.run(`CREATE OR REPLACE TABLE ${resultsTable} (batch_id BIGINT, ok BOOLEAN, status INTEGER, body_text VARCHAR)`);
  await conn.run(`CREATE OR REPLACE TABLE ${pending} AS SELECT batch_id, body FROM ${batchesTable}`);

  let round = 0;
  let backoff = opts.backoffMs ?? 500;
  for (;;) {
    const [{ np }] = await conn.all<{ np: bigint }>(`SELECT count(*) np FROM ${pending}`);
    if (Number(np) === 0) break;
    if (round >= maxRounds) break;
    round += 1;

    // launch this round's pending batches; the per-row `body` is a column arg the scalar launcher accepts
    await conn.run(
      `CREATE OR REPLACE TABLE ${launched} AS
       SELECT batch_id, ducknng_ncurl_aio(?, ?, ?, body::BLOB, ?, ${tlsExpr}) AS h FROM ${pending}`,
      [url, method, headersJson, timeoutMs],
    );
    await conn.run(`CREATE OR REPLACE TABLE ${collected} (aio_id UBIGINT, ok BOOLEAN, status INTEGER, body_text VARCHAR)`);
    const [{ need }] = await conn.all<{ need: bigint }>(`SELECT count(*) need FROM ${launched}`);
    // drain until every launched handle is terminal — do NOT assume one collect returns all of them
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
    // record 2xx successes; whatever batch is still not in results is retried next round
    await conn.run(
      `INSERT INTO ${resultsTable}
       SELECT l.batch_id, c.ok, c.status, c.body_text
       FROM ${launched} l JOIN ${collected} c ON c.aio_id = l.h
       WHERE c.ok AND c.status BETWEEN 200 AND 299`,
    );
    await conn.run(
      `CREATE OR REPLACE TABLE ${pending} AS
       SELECT b.batch_id, b.body FROM ${batchesTable} b
       WHERE b.batch_id NOT IN (SELECT batch_id FROM ${resultsTable})`,
    );
    const [{ remaining }] = await conn.all<{ remaining: bigint }>(`SELECT count(*) remaining FROM ${pending}`);
    if (Number(remaining) > 0 && round < maxRounds) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  const [{ succeeded }] = await conn.all<{ succeeded: bigint }>(`SELECT count(*) succeeded FROM ${resultsTable}`);
  const [{ failed }] = await conn.all<{ failed: bigint }>(`SELECT count(*) failed FROM ${pending}`);
  for (const t of [launched, collected, pending]) await conn.run(`DROP TABLE IF EXISTS ${t}`);
  return { rounds: round, succeeded: Number(succeeded), failed: Number(failed) };
}
