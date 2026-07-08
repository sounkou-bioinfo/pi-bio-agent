import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema } from "../src/duckdb/observations.js";
import { recordHostEvent } from "../src/hosts/host-events.js";

const ducknngExtensionPath = process.env.DUCKNNG_EXTENSION_PATH;
const ducknngLoadSql = ducknngExtensionPath ? `LOAD '${ducknngExtensionPath.replace(/'/g, "''")}'` : "LOAD ducknng";

const ducknngUploadAvailable = await (async () => {
  let inst: Awaited<ReturnType<typeof DuckDBInstance.create>> | undefined;
  try {
    inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const raw = await inst.connect();
    if (!ducknngExtensionPath) await raw.run("INSTALL ducknng FROM community");
    await raw.run(ducknngLoadSql);
    const fn = await raw.runAndReadAll("SELECT count(*) AS n FROM duckdb_functions() WHERE function_name = 'ducknng_upload_table'");
    if (Number(fn.getRowObjects()[0]?.n ?? 0) === 0) return false;
    await raw.run("SELECT ducknng_register_upload_methods(false)");
    return true;
  } catch {
    return false;
  } finally {
    inst?.closeSync();
  }
})();

async function openDucknngConnection() {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const raw = await inst.connect();
  await raw.run(ducknngLoadSql);
  return { inst, raw };
}

describe("ducknng upload lane as sibling shared-data transport", {
  skip: ducknngUploadAvailable ? false : "ducknng upload lane unavailable",
}, () => {
  test("streams local SQL rows into a remote table and records a host transport receipt in the ledger", async () => {
    const server = await openDucknngConnection();
    const client = await openDucknngConnection();
    try {
      await server.raw.run("CREATE TABLE uploaded_variants(variant_key VARCHAR, score INTEGER)");
      await server.raw.run("SELECT ducknng_start_server('upload_dogfood', 'tcp://127.0.0.1:0', 1, 134217728, 300000, 0::UBIGINT)");
      await server.raw.run("SELECT ducknng_register_upload_methods(false)");
      const url = String((await server.raw.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name = 'upload_dogfood'")).getRows()[0]![0]);

      await client.raw.run(`
        CREATE TABLE local_candidates AS
        SELECT * FROM (VALUES
          ('var-a', 10::INTEGER),
          ('var-b', 20::INTEGER),
          ('var-c', 30::INTEGER)
        ) AS t(variant_key, score)
      `);
      const upload = (await client.raw.runAndReadAll(
        "SELECT rows_uploaded, bytes_uploaded FROM ducknng_upload_table(?, ?, ?)",
        [url, "SELECT variant_key, score::INTEGER AS score FROM local_candidates ORDER BY variant_key", "uploaded_variants"],
      )).getRowObjects()[0] as { rows_uploaded?: bigint; bytes_uploaded?: bigint };
      assert.equal(Number(upload.rows_uploaded), 3);
      assert.ok(Number(upload.bytes_uploaded) > 0);

      const uploadedRows = (await server.raw.runAndReadAll(
        "SELECT count(*) AS n, sum(score) AS total_score, string_agg(variant_key, ',' ORDER BY variant_key) AS keys FROM uploaded_variants",
      )).getRowObjects()[0] as { n?: bigint; total_score?: bigint; keys?: string };
      assert.deepEqual({
        n: Number(uploadedRows.n),
        totalScore: Number(uploadedRows.total_score),
        keys: uploadedRows.keys,
      }, { n: 3, totalScore: 60, keys: "var-a,var-b,var-c" });

      await assert.rejects(
        () => client.raw.runAndReadAll(
          "SELECT rows_uploaded FROM ducknng_upload_table(?, ?, ?)",
          [url, "SELECT variant_key, score::BIGINT AS score FROM local_candidates", "uploaded_variants"],
        ),
        /quack append column|column type/i,
      );
      const afterRejected = Number((await server.raw.runAndReadAll("SELECT count(*) AS n FROM uploaded_variants")).getRowObjects()[0]?.n ?? -1);
      assert.equal(afterRejected, 3, "a rejected upload transaction did not append partial rows");

      const conn = duckdbNodeConn(server.raw);
      await createBioObservationSchema(conn);
      const receipt = await recordHostEvent(conn, {
        subjectId: "transport:ducknng-upload:dogfood",
        kind: "dogfood.ducknng.upload_committed",
        recordedAt: "2026-07-08T00:00:00.000Z",
        source: "ducknng-upload-shared-data.test",
        value: {
          target_table: "uploaded_variants",
          rows_uploaded: Number(upload.rows_uploaded),
          bytes_uploaded: Number(upload.bytes_uploaded),
          transport: "ducknng_upload_table",
        },
        links: [
          { predicate: "writes_table", objectId: "table:uploaded_variants" },
          { predicate: "uses_transport", objectId: "transport:ducknng.upload" },
        ],
      });
      assert.equal(receipt.linkObservationIds.length, 2);
      const eventRows = await conn.all<{ kind: string }>(
        "SELECT json_extract_string(value_json, '$.kind') AS kind FROM bio_observations WHERE predicate = 'host_event'",
      );
      assert.deepEqual(eventRows, [{ kind: "dogfood.ducknng.upload_committed" }]);
    } finally {
      try { await server.raw.run("SELECT ducknng_stop_server('upload_dogfood')"); } catch { /* best effort */ }
      client.inst.closeSync();
      server.inst.closeSync();
    }
  });
});
