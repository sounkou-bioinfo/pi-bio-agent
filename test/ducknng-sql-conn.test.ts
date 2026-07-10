import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createDucknngSqlConn } from "../src/hosts/ducknng-sql-conn.js";

const extensionPath = process.env.DUCKNNG_EXTENSION_PATH;
const loadSql = extensionPath
  ? "LOAD '" + extensionPath.replace(/'/g, "''") + "'"
  : "LOAD ducknng";

async function openDucknng() {
  const instance = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const raw = await instance.connect();
  if (!extensionPath) await raw.run("INSTALL ducknng FROM community");
  await raw.run(loadSql);
  return { instance, raw, conn: duckdbNodeConn(raw) };
}

const typedRpcAvailable = await (async () => {
  try {
    const { instance, raw, conn } = await openDucknng();
    try {
      const [{ count }] = await conn.all<{ count: bigint }>(
        `SELECT count(*) AS count
         FROM duckdb_functions()
         WHERE function_name IN (
           'ducknng_query_rpc_params',
           'ducknng_run_rpc_params',
           'ducknng_self_signed_tls_config'
         )`,
      );
      const available = count === 3n;
      if (extensionPath && !available) throw new Error("owned ducknng build lacks typed RPC or TLS functions");
      return available;
    } finally {
      raw.closeSync?.();
      instance.closeSync?.();
    }
  } catch (error) {
    if (extensionPath) throw error;
    return false;
  }
})();

describe("ducknng SqlConn adapter", { skip: typedRpcAvailable ? false : "typed ducknng RPC unavailable" }, () => {
  test("binds values remotely over native TLS without interpolating SQL", async () => {
    const { instance, raw, conn } = await openDucknng();
    const service = "sql_conn_" + randomUUID().replace(/-/g, "").slice(0, 10);
    try {
      await conn.run(
        "CREATE TABLE remote_items (id BIGINT PRIMARY KEY, note VARCHAR, enabled BOOLEAN, payload BLOB, optional VARCHAR)",
      );
      const [{ tls }] = await conn.all<{ tls: bigint }>(
        "SELECT ducknng_self_signed_tls_config('127.0.0.1', 1, 0) AS tls",
      );
      await conn.run(
        "SELECT ducknng_start_server(?, 'tls+tcp://127.0.0.1:0', 1, 134217728, 300000, ?::UBIGINT)",
        [service, tls],
      );
      await conn.run("SELECT ducknng_register_exec_method(false)");
      const [{ listen }] = await conn.all<{ listen: string }>(
        "SELECT listen FROM ducknng_list_servers() WHERE name = ?",
        [service],
      );
      const remote = createDucknngSqlConn({ client: conn, url: listen, tlsConfigId: tls });
      const note = "O'Brien asked: value = ?; keep it literal";
      const payload = new Uint8Array([0, 1, 127, 255]);

      await remote.run(
        "INSERT INTO remote_items VALUES (?, ?, ?, ?, ?::VARCHAR)",
        [9007199254740993n, note, true, payload, null],
      );
      const rows = await remote.all<{
        id: bigint;
        note: string;
        enabled: boolean;
        payload: Uint8Array;
        optional: null;
      }>(
        "SELECT id, note, enabled, payload, optional FROM remote_items WHERE id = ? AND note = ?",
        [9007199254740993n, note],
      );
      assert.deepEqual(Array.from(rows[0]!.payload), Array.from(payload));
      assert.deepEqual(rows.map(({ payload: _payload, ...row }) => row), [{
        id: 9007199254740993n,
        note,
        enabled: true,
        optional: null,
      }]);

      const returned = await remote.all<{ id: bigint }>(
        "INSERT INTO remote_items VALUES (?, ?, false, ?, NULL) RETURNING id",
        [9007199254740995n, "second ?", new Uint8Array([2])],
      );
      assert.deepEqual(returned, [{ id: 9007199254740995n }]);
      assert.deepEqual(await remote.all<{ count: bigint }>("SELECT count(*) AS count FROM remote_items"), [{ count: 2n }]);

      const nested = await remote.all<{
        values: (number | null)[];
        empty: string[];
        record: { gene: string; score: number };
      }>(
        "SELECT ?::INTEGER[] AS values, ?::VARCHAR[] AS empty, ?::STRUCT(gene VARCHAR, score DOUBLE) AS record",
        [[1, null, 3], [], { gene: "BRCA2", score: 0.75 }],
      );
      assert.deepEqual(nested, [{
        values: [1, null, 3],
        empty: [],
        record: { gene: "BRCA2", score: 0.75 },
      }]);
      const exotic = { "gene.symbol": "BRCA2", "quoted\"field": "kept" };
      const [exoticRow] = await remote.all<{ record: Record<string, string> }>(
        "SELECT ? AS record",
        [exotic],
      );
      assert.deepEqual(exoticRow!.record, exotic);
      const paritySql =
        "SELECT typeof(?) AS number_type, typeof(?) AS bigint_type, ? IS NULL AS null_value, " +
        "?::INTEGER AS integer_target, ?::DECIMAL(10,2)::VARCHAR AS decimal_target";
      const parityParams = [7, 42n, null, 7, "12.34"];
      assert.deepEqual(await remote.all(paritySql, parityParams), await conn.all(paritySql, parityParams));

      await assert.rejects(
        () => remote.run("INSERT INTO remote_items VALUES (?, 'duplicate', false, ?, NULL)", [
          9007199254740993n,
          new Uint8Array(),
        ]),
        /remote exec failed.*constraint/i,
      );

      await conn.run(
        "SELECT ducknng_set_service_authorizer(?, ?)",
        [
          service,
          "SELECT rpc_method <> 'query_open' AS allow, 403 AS status, " +
            "'query_open denied by host policy' AS reason FROM ducknng_auth_context()",
        ],
      );
      await assert.rejects(
        () => remote.all("SELECT count(*) AS count FROM remote_items"),
        /query_open denied by host policy/,
      );
      await conn.run("SELECT ducknng_set_service_authorizer(?, NULL)", [service]);
    } finally {
      await conn.run("SELECT ducknng_stop_server(?)", [service]).catch(() => {});
      raw.closeSync?.();
      instance.closeSync();
    }
  });
});

test("ducknng SqlConn rejects invalid local composition before transport", async () => {
  const client = {
    all: async () => [],
    run: async () => {},
  };
  assert.throws(() => createDucknngSqlConn({ client, url: "  " }), /service URL/);
  assert.throws(() => createDucknngSqlConn({ client, url: "tcp://host:1", tlsConfigId: -1n }), /non-negative/);
  const remote = createDucknngSqlConn({ client, url: "tcp://host:1" });
  await assert.rejects(
    () => remote.all("SELECT 1", Array.from({ length: 65_536 })),
    /at most 65,535 parameters/,
  );
  await assert.rejects(
    () => remote.all("SELECT 1", [Array.from({ length: 65_535 }, () => 1)]),
    /at most 65,535 value nodes/,
  );
  await assert.rejects(
    () => remote.all("SELECT ?", [{}]),
    /struct parameters cannot be empty/,
  );
});
