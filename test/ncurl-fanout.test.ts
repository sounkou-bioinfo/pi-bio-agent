import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { ncurlFanout } from "../src/duckdb/ncurl-fanout.js";

// Deterministic test of the chunked HTTP fanout (launch -> loop-drain -> status-driven retry). A LOCAL ducknng
// server is the fixture; its POST route (a) VALIDATES the request body has a non-empty `variants` array (else
// 400) and (b) returns 503 for the first TWO calls then 200 (a server-side sequence) — so the retry path is
// genuinely exercised, not just the happy path. No external network, no mock. (This is the host-side loop the
// WGS region example uses to annotate selected variants against VEP's batch /region endpoint.)

const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch (error) {
    if (process.env.DUCKNNG_EXTENSION_PATH) throw error;
    return false;
  }
})();

const CANNED = '[{"input":"x","most_severe_consequence":"missense_variant"}]';

test("ncurlFanout rejects a pre-aborted host signal before creating tables", async () => {
  const controller = new AbortController();
  controller.abort();
  const conn = {
    all: async () => { throw new Error("ncurlFanout touched the connection after abort"); },
    run: async () => { throw new Error("ncurlFanout touched the connection after abort"); },
  };
  await assert.rejects(
    () => ncurlFanout(conn, {
      batchesTable: "batches",
      resultsTable: "results",
      url: "http://127.0.0.1:1/unused",
      headersJson: "[]",
      signal: controller.signal,
    }),
    /ncurlFanout: aborted/,
  );
});

// flaky=true: 400 on a missing `variants` array, else 503 for the first 2 calls then 200 (exercises retry).
// flaky=false: 400 on a missing `variants` array, else always 200 (isolates the permanent-400 case).
// Bind port 0 (OS-assigned) and DISCOVER the real base URL — a fixed port races under parallel test runs / TIME_WAIT.
async function startFixture(flaky: boolean): Promise<{ base: string; close(): void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const fix = duckdbNodeConn(await inst.connect());
  await fix.run("LOAD ducknng");
  await fix.run("CREATE SEQUENCE calls START 1");
  await fix.run(`SELECT ducknng_start_server('fan', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
  const base = (await fix.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='fan'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
  const okBranch = flaky ? "WHEN nextval(''calls'') > 2 THEN 200 ELSE 503" : "ELSE 200";
  await fix.run(
    `SELECT ducknng_register_http_route('fan', 'POST', '/vep', ` +
    `'SELECT * FROM ducknng_http_json(` +
    `  CASE WHEN coalesce(json_array_length((SELECT body_text FROM ducknng_http_request_body()), ''$.variants''), 0) = 0 THEN 400 ` +
    `       ${okBranch} END, ` +
    `  ''${CANNED}'')')`,
  );
  return { base, close: () => inst.closeSync() };
}

describe("ncurl fanout: chunked launch -> loop-drain -> status-driven retry", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community)" }, () => {
  test("3 batches, server 503s the first 2 calls -> retry round(s) -> all 3 ultimately succeed", async () => {
    const fixture = await startFixture(true);
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await conn.run("LOAD ducknng");
    try {
      await conn.run(`CREATE TABLE batches AS SELECT * FROM (VALUES
        (0, '{"variants":["22 1 . A G"]}'),
        (1, '{"variants":["22 2 . C T"]}'),
        (2, '{"variants":["22 3 . G A"]}')) t(batch_id, body)`);
      const res = await ncurlFanout(conn, {
        batchesTable: "batches", resultsTable: "results",
        url: `${fixture.base}/vep`,
        headersJson: '[{"name":"Content-Type","value":"application/json"}]',
        drainWaitMs: 500, backoffMs: 10, maxRounds: 5,
      });
      assert.equal(res.succeeded, 3); // all three eventually 2xx
      assert.equal(res.failures.length, 0);
      assert.ok(res.waves >= 2, `expected a retry wave (got ${res.waves})`); // 503 is transient -> retried
      const rows = await conn.all<{ n: bigint }>("SELECT count(*) n FROM results WHERE status = 200");
      assert.equal(Number(rows[0].n), 3);
      const body = await conn.all<{ body_text: string }>("SELECT DISTINCT body_text FROM results");
      assert.equal(body[0].body_text, CANNED); // the canned VEP-shaped body round-tripped
    } finally { conn.run("DROP TABLE IF EXISTS batches"); fixture.close(); }
  });

  test("more batches than maxInFlight -> multiple waves, every batch processed (not just the first wave)", async () => {
    const fixture = await startFixture(false); // always-200 for valid bodies
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await conn.run("LOAD ducknng");
    try {
      // 5 batches, maxInFlight 2 -> at least 3 waves; ALL must succeed (guards the dropped-un-launched-batch bug)
      await conn.run(`CREATE TABLE batches AS SELECT batch_id, '{"variants":["22 ' || batch_id || ' . A G"]}' AS body FROM range(5) t(batch_id)`);
      const res = await ncurlFanout(conn, {
        batchesTable: "batches", resultsTable: "results",
        url: `${fixture.base}/vep`,
        headersJson: '[{"name":"Content-Type","value":"application/json"}]',
        drainWaitMs: 400, maxInFlight: 2,
      });
      assert.equal(res.succeeded, 5); // every batch annotated, across waves
      assert.equal(res.failures.length, 0);
      assert.ok(res.waves >= 3, `5 batches @ maxInFlight 2 should take >=3 waves (got ${res.waves})`);
    } finally { conn.run("DROP TABLE IF EXISTS batches"); fixture.close(); }
  });

  test("a batch whose body lacks `variants` 400s -> PERMANENT terminal failure (not retried); valid batch succeeds", async () => {
    const fixture = await startFixture(false);
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await conn.run("LOAD ducknng");
    try {
      await conn.run(`CREATE TABLE batches AS SELECT * FROM (VALUES
        (0, '{"variants":["22 1 . A G"]}'),
        (1, '{"oops":true}')) t(batch_id, body)`); // batch 1 is malformed -> permanent 400
      const res = await ncurlFanout(conn, {
        batchesTable: "batches", resultsTable: "results",
        url: `${fixture.base}/vep`,
        headersJson: '[{"name":"Content-Type","value":"application/json"}]',
        drainWaitMs: 300, backoffMs: 5, maxRounds: 4,
      });
      assert.equal(res.succeeded, 1);
      assert.equal(res.waves, 1); // 400 is permanent -> terminated on the FIRST wave, no wasted retries
      assert.deepEqual(res.failures, [{ batchId: 1, status: 400, transient: false }]);
      const ok = await conn.all<{ batch_id: bigint }>("SELECT batch_id FROM results ORDER BY batch_id");
      assert.deepEqual(ok.map((r) => Number(r.batch_id)), [0]); // only the well-formed batch is in results
    } finally { conn.run("DROP TABLE IF EXISTS batches"); fixture.close(); }
  });
});
