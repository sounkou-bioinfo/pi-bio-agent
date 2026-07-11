import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { ducknngHttpFanoutResolver } from "../src/duckdb/resolvers/ducknng-http-fanout.js";

const ducknngAvailable = await (async () => {
  try {
    const instance = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const connection = await instance.connect();
    await connection.run("INSTALL ducknng FROM community; LOAD ducknng;");
    connection.closeSync();
    instance.closeSync();
    return true;
  } catch (error) {
    if (process.env.DUCKNNG_EXTENSION_PATH) throw error;
    return false;
  }
})();

describe("ducknng.http_fanout resolver", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
test("runs declared batch SQL through AIO retry and exposes response rows as a table", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      const body = JSON.stringify([{ input: "22 1 . A G", most_severe_consequence: "missense_variant" }]);
      response.writeHead(requests <= 2 ? 503 : 200, { "content-type": "application/json" });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fanout fixture did not bind");

    const instance = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const connection = await instance.connect();
    const conn = duckdbNodeConn(connection);
    try {
      const output = await ducknngHttpFanoutResolver({
        id: "http_results",
        title: "HTTP results",
        kind: "virtual",
        resolver: "ducknng.http_fanout",
        params: {
          table: "http_results",
          batchesSql: "SELECT * FROM (VALUES (0, '{\"variants\":[\"22 1 . A G\"]}'), (1, '{\"variants\":[\"22 2 . C T\"]}'), (2, '{\"variants\":[\"22 3 . G A\"]}')) AS batches(batch_id, body)",
          url: `http://127.0.0.1:${address.port}/fanout`,
          headersJson: "[]",
          extensions: ["ducknng"],
          maxInFlight: 3,
          maxRounds: 4,
          timeoutMs: 5000,
        },
      }, { conn, now: "2026-07-11T00:00:00Z" });

      assert.equal(requests, 5);
      assert.deepEqual(await conn.all<{ n: bigint }>("SELECT count(*) AS n FROM http_results"), [{ n: 3n }]);
      assert.deepEqual(await conn.all<{ n: bigint }>("SELECT count(*) AS n FROM http_results WHERE status BETWEEN 200 AND 299"), [{ n: 3n }]);
      assert.equal(output.result.pointer?.uri, "table:http_results");
      assert.ok(output.provenance[0]?.notes?.includes("ducknng_ncurl_aio"));
      assert.ok(output.provenance[0]?.notes?.includes("waves:2"));
    } finally {
      connection.closeSync();
      instance.closeSync();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
