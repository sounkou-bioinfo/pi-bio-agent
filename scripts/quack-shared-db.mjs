import { DuckDBInstance } from "@duckdb/node-api";

// LIVE quack demo (dogfood): MULTIPLE agent PROCESSES sharing one LIVE MUTABLE DuckDB without the file lock.
// One server process runs quack_serve() and OWNS the db file; client processes (each with their OWN :memory:
// db — they never open the shared file) ATTACH over the quack protocol and READ + WRITE the shared table. This
// is the case the host-single-writer / CAS demos deliberately avoid: genuinely shared writable state across
// processes. In the substrate, a client attaches via the host-owned connection-init hook (duckdbInitSql:
// LOAD quack; CREATE SECRET ...; ATTACH 'quack:host' AS shared).
//
// Run: node scripts/quack-shared-db.mjs serve   (in one terminal)
//      node scripts/quack-shared-db.mjs client A (in others, while the server holds)

const [mode, name] = process.argv.slice(2);
const ADDR = "quack:localhost:9876", TOKEN = "secret-123", FILE = "/tmp/quack-shared.duckdb";

if (mode === "serve") {
  const inst = await DuckDBInstance.create(FILE);
  const c = await inst.connect();
  await c.run("LOAD quack");
  await c.run("CREATE OR REPLACE TABLE shared(agent VARCHAR, msg VARCHAR)");
  await c.run(`CALL quack_serve('${ADDR}', token = '${TOKEN}')`);
  console.log(`server pid ${process.pid}: quack_serve on ${ADDR}; owns ${FILE}; holding ~9s`);
  await new Promise((r) => setTimeout(r, 9000));
  const rows = (await c.runAndReadAll("SELECT agent, msg FROM shared ORDER BY agent")).getRows();
  console.log("server: FINAL shared table (rows written by SEPARATE client processes via quack):");
  for (const [agent, msg] of rows) console.log(`  ${agent}: ${msg}`);
  c.closeSync(); inst.closeSync();
} else if (mode === "client") {
  const inst = await DuckDBInstance.create(":memory:"); // the client owns NO shared file — it talks to the server
  const c = await inst.connect();
  await c.run("LOAD quack");
  await c.run(`CREATE SECRET (TYPE quack, TOKEN '${TOKEN}')`);
  await c.run(`ATTACH '${ADDR}' AS remote`);
  await c.run(`INSERT INTO remote.shared VALUES ('${name}', 'hello from ${name} pid ${process.pid}')`);
  const n = Number((await c.runAndReadAll("SELECT count(*)::INTEGER FROM remote.shared")).getRows()[0][0]);
  console.log(`client ${name} (pid ${process.pid}): WROTE to the shared db via quack; shared row count now = ${n}`);
  c.closeSync(); inst.closeSync();
}
