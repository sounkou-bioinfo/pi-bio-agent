import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";

// Locks the quack -> ducknng PIVOT: cross-process shared MUTABLE state over ducknng RPC — the thing quack cannot
// do (its local-catalog storage shim throws on UPDATE/DELETE/ON CONFLICT). Deterministic and self-contained:
// ducknng ships the server, so one DuckDBInstance hosts an RPC server over a table and a SEPARATE instance (its
// own catalog = a cross-process-equivalent client) mutates it via ducknng_run_rpc. No external network. This is
// the test backing scripts/ducknng-rpc-mutate.mjs.
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

async function startServer(name: string, seedSql: string[]): Promise<{ conn: Awaited<ReturnType<DuckDBInstance["connect"]>>; url: string; close: () => void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const conn = await inst.connect();
  await conn.run("LOAD ducknng");
  for (const s of seedSql) await conn.run(s);
  await conn.run(`SELECT ducknng_start_server('${name}', 'tcp://127.0.0.1:0', 1, 134217728, 300000, 0::UBIGINT)`); // port 0 = OS-assigned
  const url = String((await conn.runAndReadAll(`SELECT listen FROM ducknng_list_servers() WHERE name = '${name}'`)).getRows()[0]![0]);
  return { conn, url, close: () => { conn.run(`SELECT ducknng_stop_server('${name}')`).catch(() => {}); inst.closeSync(); } };
}

async function client(): Promise<Awaited<ReturnType<DuckDBInstance["connect"]>>> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" }); // own catalog — talks only RPC, never opens the server's db
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  return c;
}

describe("ducknng RPC: cross-process shared MUTABLE state (the quack->ducknng pivot)", { skip: ducknngAvailable ? false : "ducknng unavailable (INSTALL ducknng FROM community on a matching DuckDB)" }, () => {
  test("a separate-catalog client UPDATE/DELETE/upserts the server's table in place (exec opt-in)", async () => {
    const srv = await startServer("mut", ["CREATE TABLE shared (k INTEGER PRIMARY KEY, v INTEGER)", "INSERT INTO shared VALUES (1,10),(2,20)"]);
    await srv.conn.run("SELECT ducknng_register_exec_method(false)"); // EXEC OPT-IN — the host security boundary
    const c = await client();
    const rpc = async (sql: string): Promise<{ ok: boolean; rows_changed: number }> => {
      const row = (await c.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${srv.url}', ?, 0::UBIGINT)`, [sql])).getRowObjects()[0] as { ok?: boolean; rows_changed?: bigint };
      return { ok: row.ok === true, rows_changed: Number(row.rows_changed ?? -1) };
    };
    // the exact operations quack rejects (GetStorageInfo/PlanUpdate/PlanDelete NotImplemented)
    assert.deepEqual(await rpc("INSERT INTO shared VALUES (3, 30)"), { ok: true, rows_changed: 1 });
    assert.deepEqual(await rpc("UPDATE shared SET v = 99 WHERE k = 1"), { ok: true, rows_changed: 1 });
    assert.deepEqual(await rpc("DELETE FROM shared WHERE k = 2"), { ok: true, rows_changed: 1 });
    assert.deepEqual(await rpc("INSERT INTO shared VALUES (3, 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v"), { ok: true, rows_changed: 1 });

    // the server's OWN catalog reflects the remote mutations
    const onServer = (await srv.conn.runAndReadAll("SELECT k, v FROM shared ORDER BY k")).getRows().map((r) => r.map(Number));
    assert.deepEqual(onServer, [[1, 99], [3, 5]], "k1 updated, k2 deleted, k3 inserted-then-upserted");

    // and a read RPC sees the same shared state
    const viaRead = (await c.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${srv.url}', ?, 0::UBIGINT)`, ["SELECT k, v FROM shared ORDER BY k"])).getRows().map((r) => r.map(Number));
    assert.deepEqual(viaRead, [[1, 99], [3, 5]], "query_rpc read sees the mutated shared table");
    srv.close();
  });

  test("run_rpc fails closed until exec is registered (the host security boundary)", async () => {
    const srv = await startServer("locked", ["CREATE TABLE t (k INTEGER)"]); // NO register_exec_method
    const c = await client();
    const row = (await c.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${srv.url}', ?, 0::UBIGINT)`, ["INSERT INTO t VALUES (1)"])).getRowObjects()[0] as { ok?: boolean; error?: string };
    assert.equal(row.ok, false, "exec is refused without an explicit register_exec_method");
    assert.match(String(row.error ?? ""), /unknown RPC method/);
    const n = Number((await srv.conn.runAndReadAll("SELECT count(*)::INTEGER FROM t")).getRows()[0]![0]);
    assert.equal(n, 0, "the table was NOT mutated (fail closed)");
    srv.close();
  });
});
