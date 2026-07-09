import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

const ducknngExtensionPath = process.env.DUCKNNG_EXTENSION_PATH;
const ducknngLoadSql = ducknngExtensionPath ? `LOAD '${ducknngExtensionPath.replace(/'/g, "''")}'` : "LOAD ducknng";

async function openDucknngConn() {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const raw = await inst.connect();
  const conn = duckdbNodeConn(raw);
  if (!ducknngExtensionPath) await conn.run("INSTALL ducknng FROM community");
  await conn.run(ducknngLoadSql);
  return { inst, raw, conn };
}

const ducknngTlsAvailable = await (async () => {
  try {
    const { inst, raw, conn } = await openDucknngConn();
    try {
      const rows = await conn.all<{ n: bigint }>(
        `SELECT count(*) AS n
         FROM duckdb_functions()
         WHERE function_name IN (
           'ducknng_self_signed_tls_config',
           'ducknng_start_server',
           'ducknng_query_rpc',
           'ducknng_get_rpc_manifest',
           'ducknng_set_service_peer_allowlist'
         )`,
      );
      return Number(rows[0]?.n ?? 0) >= 5;
    } finally {
      raw.closeSync?.();
      inst.closeSync?.();
    }
  } catch (error) {
    if (ducknngExtensionPath) throw error;
    return false;
  }
})();

function serviceName(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

describe("ducknng TLS/mTLS runtime fixture", { skip: ducknngTlsAvailable ? false : "ducknng TLS functions unavailable" }, () => {
  test("tls+tcp RPC uses a host-provisioned TLS handle", async () => {
    const { inst, raw, conn } = await openDucknngConn();
    let name: string | undefined;
    try {
      name = serviceName("tls_rpc");
      const [{ tls }] = await conn.all<{ tls: bigint }>(
        `SELECT ducknng_self_signed_tls_config('127.0.0.1', 1, 0) AS tls`,
      );
      await conn.run(
        `SELECT ducknng_start_server('${name}', 'tls+tcp://127.0.0.1:0', 1, 134217728, 300000, ${tls}::UBIGINT)`,
      );
      const server = await conn.all<{ listen: string; tls_enabled: boolean; tls_auth_mode: number; peer_identity_required: boolean }>(
        `SELECT listen, tls_enabled, tls_auth_mode, peer_identity_required FROM ducknng_list_servers() WHERE name = '${name}'`,
      );
      assert.equal(server.length, 1);
      assert.equal(server[0]!.tls_enabled, true);
      assert.equal(server[0]!.tls_auth_mode, 0);
      assert.equal(server[0]!.peer_identity_required, false);

      const rows = await conn.all<{ answer: number }>(
        `SELECT * FROM ducknng_query_rpc('${server[0]!.listen}', 'SELECT 42 AS answer', ${tls}::UBIGINT)`,
      );
      assert.deepEqual(rows, [{ answer: 42 }]);
    } finally {
      if (name) await conn.run(`SELECT ducknng_stop_server('${name}')`).catch(() => {});
      raw.closeSync?.();
      inst.closeSync();
    }
  });

  test("mTLS requires a client certificate and enforces an exact peer identity allowlist", async () => {
    const { inst, raw, conn } = await openDucknngConn();
    let name: string | undefined;
    try {
      name = serviceName("mtls_rpc");
      const [{ tls }] = await conn.all<{ tls: bigint }>(
        `SELECT ducknng_self_signed_tls_config('127.0.0.1', 1, 2) AS tls`,
      );
      await conn.run(
        `SELECT ducknng_start_server('${name}', 'tls+tcp://127.0.0.1:0', 1, 134217728, 300000, ${tls}::UBIGINT)`,
      );
      const server = await conn.all<{ listen: string; tls_enabled: boolean; tls_auth_mode: number; peer_identity_required: boolean }>(
        `SELECT listen, tls_enabled, tls_auth_mode, peer_identity_required FROM ducknng_list_servers() WHERE name = '${name}'`,
      );
      assert.equal(server.length, 1);
      assert.equal(server[0]!.tls_enabled, true);
      assert.equal(server[0]!.tls_auth_mode, 2);
      assert.equal(server[0]!.peer_identity_required, true);

      await assert.rejects(
        () => conn.all(`SELECT * FROM ducknng_query_rpc('${server[0]!.listen}', 'SELECT 1 AS ok', 0::UBIGINT)`),
        /Peer could not be authenticated|TLS|auth/i,
      );

      const allow = await conn.all<{ ok: boolean }>(
        `SELECT ducknng_set_service_peer_allowlist('${name}', '["tls:cn:127.0.0.1"]') AS ok`,
      );
      assert.equal(allow[0]?.ok, true);
      const policy = await conn.all<{ peer_allowlist_active: boolean; peer_allowlist_count: bigint }>(
        `SELECT peer_allowlist_active, peer_allowlist_count FROM ducknng_list_servers() WHERE name = '${name}'`,
      );
      assert.deepEqual(policy, [{ peer_allowlist_active: true, peer_allowlist_count: 1n }]);

      const rows = await conn.all<{ ok: number }>(
        `SELECT * FROM ducknng_query_rpc('${server[0]!.listen}', 'SELECT 1 AS ok', ${tls}::UBIGINT)`,
      );
      assert.deepEqual(rows, [{ ok: 1 }]);

      await conn.run(`SELECT ducknng_set_service_peer_allowlist('${name}', '["tls:san:not-this-client"]')`);
      const denied = await conn.all<{ ok: boolean; has_error: boolean }>(
        `SELECT ok, error IS NOT NULL AS has_error FROM ducknng_get_rpc_manifest('${server[0]!.listen}', ${tls}::UBIGINT)`,
      );
      assert.deepEqual(denied, [{ ok: false, has_error: true }]);
    } finally {
      if (name) await conn.run(`SELECT ducknng_stop_server('${name}')`).catch(() => {});
      raw.closeSync?.();
      inst.closeSync();
    }
  });
});
