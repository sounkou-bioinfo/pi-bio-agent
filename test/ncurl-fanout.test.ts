import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { ncurlFanout } from "../src/duckdb/ncurl-fanout.js";

// Deterministic test of the chunked HTTP fanout (launch -> loop-drain -> status-driven retry). A LOCAL ducknng
// server is the fixture; its POST route (a) VALIDATES the request body has a non-empty `variants` array (else
// 400) and (b) returns 503 for the first TWO calls then 200 (a server-side sequence) — so the retry path is
// genuinely exercised, not just the happy path. No external network, no mock. (This is the host-side loop the
// WGS-chr22 flagship uses to annotate a whole VCF against VEP's batch /region endpoint.)

const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

const CANNED = '[{"input":"x","most_severe_consequence":"missense_variant"}]';

// flaky=true: 400 on a missing `variants` array, else 503 for the first 2 calls then 200 (exercises retry).
// flaky=false: 400 on a missing `variants` array, else always 200 (isolates the permanent-400 case).
async function startFixture(port: number, flaky: boolean): Promise<{ close(): void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const fix = duckdbNodeConn(await inst.connect());
  await fix.run("LOAD ducknng");
  await fix.run("CREATE SEQUENCE calls START 1");
  await fix.run(`SELECT ducknng_start_server('fan_${port}', 'http://127.0.0.1:${port}/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
  const okBranch = flaky ? "WHEN nextval(''calls'') > 2 THEN 200 ELSE 503" : "ELSE 200";
  await fix.run(
    `SELECT ducknng_register_http_route('fan_${port}', 'POST', '/vep', ` +
    `'SELECT * FROM ducknng_http_json(` +
    `  CASE WHEN coalesce(json_array_length((SELECT body_text FROM ducknng_http_request_body()), ''$.variants''), 0) = 0 THEN 400 ` +
    `       ${okBranch} END, ` +
    `  ''${CANNED}'')')`,
  );
  return { close: () => inst.closeSync() };
}

describe("ncurl fanout: chunked launch -> loop-drain -> status-driven retry", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community)" }, () => {
  test("3 batches, server 503s the first 2 calls -> retry round(s) -> all 3 ultimately succeed", async () => {
    const fixture = await startFixture(47860, true);
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await conn.run("LOAD ducknng");
    try {
      await conn.run(`CREATE TABLE batches AS SELECT * FROM (VALUES
        (0, '{"variants":["22 1 . A G"]}'),
        (1, '{"variants":["22 2 . C T"]}'),
        (2, '{"variants":["22 3 . G A"]}')) t(batch_id, body)`);
      const res = await ncurlFanout(conn, {
        batchesTable: "batches", resultsTable: "results",
        url: "http://127.0.0.1:47860/vep",
        headersJson: '[{"name":"Content-Type","value":"application/json"}]',
        drainWaitMs: 500, backoffMs: 10, maxRounds: 5,
      });
      assert.equal(res.succeeded, 3); // all three eventually 2xx
      assert.equal(res.failed, 0);
      assert.ok(res.rounds >= 2, `expected a retry round (got ${res.rounds})`); // the first 2 calls 503'd -> retry
      const rows = await conn.all<{ n: bigint }>("SELECT count(*) n FROM results WHERE status = 200");
      assert.equal(Number(rows[0].n), 3);
      const body = await conn.all<{ body_text: string }>("SELECT DISTINCT body_text FROM results");
      assert.equal(body[0].body_text, CANNED); // the canned VEP-shaped body round-tripped
    } finally { conn.run("DROP TABLE IF EXISTS batches"); fixture.close(); }
  });

  test("a batch whose body lacks `variants` 400s and stays failed; valid batches still succeed", async () => {
    const fixture = await startFixture(47861, false);
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await conn.run("LOAD ducknng");
    try {
      await conn.run(`CREATE TABLE batches AS SELECT * FROM (VALUES
        (0, '{"variants":["22 1 . A G"]}'),
        (1, '{"oops":true}')) t(batch_id, body)`); // batch 1 is malformed -> permanent 400
      const res = await ncurlFanout(conn, {
        batchesTable: "batches", resultsTable: "results",
        url: "http://127.0.0.1:47861/vep",
        headersJson: '[{"name":"Content-Type","value":"application/json"}]',
        drainWaitMs: 300, backoffMs: 5, maxRounds: 2, // small: don't spin on the permanent failure
      });
      assert.equal(res.failed, 1); // the malformed batch never reaches 2xx
      const ok = await conn.all<{ batch_id: bigint }>("SELECT batch_id FROM results ORDER BY batch_id");
      assert.deepEqual(ok.map((r) => Number(r.batch_id)), [0]); // only the well-formed batch is in results
    } finally { conn.run("DROP TABLE IF EXISTS batches"); fixture.close(); }
  });
});
