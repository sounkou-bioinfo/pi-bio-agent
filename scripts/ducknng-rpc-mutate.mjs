import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

// PATTERN: cross-process shared MUTABLE state over ducknng RPC — the replacement for the quack demo, and it does
// what quack CANNOT. quack makes a remote table a LOCAL CATALOG ENTRY, so DuckDB calls GetStorageInfo/PlanUpdate/
// PlanDelete on quack's shim (unimplemented at HEAD) => quack remote writes are APPEND-ONLY. ducknng_run_rpc(url,
// sql, tls) instead sends a SQL STRING to a server running NATIVE DuckDB (no shim), so UPDATE / DELETE / ON
// CONFLICT all work. Exec is OPT-IN: the server must ducknng_register_exec_method(...) (the host security
// boundary, vs quack's open-by-ATTACH). Here separate agent PROCESSES mutate one shared table in place.
//
// Run:  npm run build && node scripts/ducknng-rpc-mutate.mjs

const SELF = fileURLToPath(import.meta.url);
const URL = "tcp://127.0.0.1:9879";

async function serve() {
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  await c.run("CREATE TABLE shared (k INTEGER PRIMARY KEY, v INTEGER)");
  await c.run("INSERT INTO shared VALUES (1, 10), (2, 20)");
  await c.run(`SELECT ducknng_start_server('m', '${URL}', 1, 134217728, 300000, 0::UBIGINT)`);
  await c.run("SELECT ducknng_register_exec_method(false)"); // EXEC OPT-IN — the host security boundary
  console.log(`  [server pid ${process.pid}] owns table 'shared' (seed: k1=10,k2=20); exec method registered`);
  await new Promise((r) => setTimeout(r, 6000));
  const rows = (await c.runAndReadAll("SELECT k, v FROM shared ORDER BY k")).getRows();
  console.log(`  [server] FINAL shared table (mutated in place by SEPARATE client processes): ${rows.map((r) => `k${r[0]}=${r[1]}`).join(", ")}`);
  c.closeSync(); inst.closeSync();
}

async function client(label, sql) {
  const inst = await DuckDBInstance.create(":memory:"); // owns NO shared state — only talks RPC
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  const row = (await c.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${URL}', ?, 0::UBIGINT)`, [sql])).getRowObjects()[0] ?? {};
  console.log(`  [agent ${label} pid ${process.pid}] ${row.ok ? "OK" : "ERR"} ${sql}  (rows_changed=${Number(row.rows_changed ?? -1)})`);
  c.closeSync(); inst.closeSync();
}

function spawnChild(args) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [SELF, ...args], { stdio: ["ignore", "inherit", "inherit"] });
    ch.on("error", reject);
    ch.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`))));
  });
}

async function orchestrate() {
  console.log("=== SHARED MUTABLE STATE over ducknng RPC: separate processes UPDATE/DELETE one table (quack can't) ===\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1300)); // let the server bind + register exec
  // sequential so the upsert sees the insert; each op is a SEPARATE process talking only RPC
  await spawnChild(["client", "inserter", "INSERT INTO shared VALUES (3, 30)"]);
  await spawnChild(["client", "updater", "UPDATE shared SET v = 99 WHERE k = 1"]);
  await spawnChild(["client", "deleter", "DELETE FROM shared WHERE k = 2"]);
  await spawnChild(["client", "upserter", "INSERT INTO shared VALUES (3, 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v"]);
  await server;
  console.log("\nWhat it proves: four DISTINCT processes mutated one shared table IN PLACE over ducknng RPC —");
  console.log("an UPDATE, a DELETE, and an ON CONFLICT upsert, none of which quack supports (its storage shim");
  console.log("throws NotImplementedException). The server ran each SQL string on NATIVE DuckDB; exec was opt-in.");
  console.log("Final k1=99 (updated), k2 gone (deleted), k3=5 (inserted 30 -> upserted 5). This is the");
  console.log("mutate-in-place shared-state primitive a fact-superseding KG (Phase-4 activate/rollback) needs.");
}

const [mode, label, sql] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "client" ? client(label, sql) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
