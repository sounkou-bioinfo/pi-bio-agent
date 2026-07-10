import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createDucknngSqlConn } from "../dist/hosts/ducknng-sql-conn.js";
import { resolveDucknngRuntime } from "./ducknng-runtime.mjs";

// DOGFOOD: topology x shared-writes — the decentralized BLACKBOARD (pub/sub) running ACROSS PROCESSES over
// ducknng RPC (quack is dropped for this mutable shared-state path). Each agent is a SEPARATE OS process that coordinates ONLY
// through a shared blackboard table on a ducknng server: the typed SqlConn maps publish to remote INSERT and await
// to a polled remote SELECT. No coordinator, no client opens the db file, exec opt-in.
// (Append-only publish — first-writer-wins — is all a blackboard needs; for mutate-in-place see
// ducknng-rpc-mutate.md.) Closes the topology matrix: chain / survey / pub-sub / push-pull / shared-write.
//
// Run:  npm run build && node scripts/blackboard-shared.mjs

const SELF = fileURLToPath(import.meta.url);
const URL = "tcp://127.0.0.1:9880";
const note = (slug, deps) => JSON.stringify({ schema: "pi-bio.study_note.v1", slug, body: `${slug}(${deps.join("+") || "root"})` });
const { instanceConfig, loadSql } = await resolveDucknngRuntime();

async function serve() {
  const inst = await DuckDBInstance.create(":memory:", instanceConfig);
  const c = await inst.connect();
  await c.run(loadSql);
  await c.run("CREATE TABLE board (slug TEXT PRIMARY KEY, note TEXT)");
  await c.run(`SELECT ducknng_start_server('bb', '${URL}', 4, 134217728, 300000, 0::UBIGINT)`);
  await c.run("SELECT ducknng_register_exec_method(false)"); // exec opt-in (publish); reads need no extra method
  console.log(`  [server pid ${process.pid}] ducknng server owns the shared blackboard table`);
  await new Promise((r) => setTimeout(r, 7000));
  const rows = (await c.runAndReadAll("SELECT slug FROM board ORDER BY rowid")).getRows();
  console.log(`  [server] FINAL board (rows written by SEPARATE client processes): ${rows.map((r) => r[0]).join(", ")}`);
  await c.run("SELECT ducknng_stop_server('bb')");
  c.closeSync(); inst.closeSync();
}

async function client(slug, deps) {
  const inst = await DuckDBInstance.create(":memory:", instanceConfig); // owns NO shared state — only talks RPC
  const c = await inst.connect();
  await c.run(loadSql);
  const remote = createDucknngSqlConn({ client: duckdbNodeConn(c), url: URL });
  const present = async (s) => (await remote.all("SELECT 1 AS x FROM board WHERE slug = ?", [s])).length > 0;
  for (const d of deps) { while (!(await present(d))) await new Promise((r) => setTimeout(r, 40)); } // await = poll the shared board
  await remote.run("INSERT INTO board VALUES (?, ?)", [slug, note(slug, deps)]); // publish = INSERT
  console.log(`  [agent ${slug} pid ${process.pid}] published${deps.length ? ` after [${deps.join(", ")}]` : " (root)"}`);
  c.closeSync(); inst.closeSync();
}

function spawnChild(args) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [SELF, ...args], { stdio: ["ignore", "inherit", "inherit"] });
    ch.on("error", reject);
    ch.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${code}`))));
  });
}

async function orchestrate() {
  console.log("=== SHARED-WRITE BLACKBOARD over ducknng RPC: a decentralized pub/sub DAG across SEPARATE processes ===\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1300)); // let the server bind + register exec
  await Promise.all([ // a diamond DAG, each step a SEPARATE process launched at once; they self-sequence via the board
    spawnChild(["client", "extract", ""]),
    spawnChild(["client", "annotate", "extract"]),
    spawnChild(["client", "qc", "extract"]),
    spawnChild(["client", "classify", "annotate,qc"]),
  ]);
  await server;
  console.log("\nWhat it proves: four DISTINCT OS processes coordinated a diamond DAG through ONE shared table on a");
  console.log("ducknng server — no coordinator, no shared file handle. 'extract' published first (the others polled");
  console.log("for it via query_rpc), 'classify' last (it blocked on annotate+qc). The pub/sub order emerged from");
  console.log("the shared writes — topology x shared-writes over ducknng RPC (quack dropped for this path).");
}

const [mode, slug, depsCsv] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "client" ? client(slug, depsCsv ? depsCsv.split(",") : []) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
