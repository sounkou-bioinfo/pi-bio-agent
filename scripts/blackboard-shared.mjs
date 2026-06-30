import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { sqlBlackboard } from "../dist/hosts/sql-blackboard.js";

// DOGFOOD: topology x shared-WRITES — the decentralized BLACKBOARD (pub/sub) running ACROSS PROCESSES over a
// quack shared-mutable DuckDB. quack-shared-db.mjs proved separate processes can write one shared db; blackboard-
// run.mjs proved the pub/sub topology in-process; this composes them: each agent is a SEPARATE OS process that
// coordinates ONLY through the shared blackboard table on a quack server (publish = INSERT, await = poll SELECT),
// with NO coordinator and without any client opening the db file. The same sqlBlackboard the unit test uses,
// now genuinely cross-process. (sqlBlackboard.publish is check-then-plain-INSERT precisely so it works over
// quack, which rejects ON CONFLICT / INSERT...SELECT.)
//
// Run:  npm run build && node scripts/blackboard-shared.mjs

const SELF = fileURLToPath(import.meta.url);
const ADDR = "quack:localhost:9878", TOKEN = "bb-token-123", FILE = "/tmp/quack-blackboard.duckdb";
const TABLE = "remote._pi_bio_blackboard";
const note = (slug, body) => ({ schema: "pi-bio.study_note.v1", slug, id: slug, kind: "memory_note", title: slug, hook: slug, body, tags: [], sources: [], createdAt: "T", updatedAt: "T" });

async function serve() {
  const inst = await DuckDBInstance.create(FILE);
  const c = await inst.connect();
  await c.run("LOAD quack");
  await c.run("CREATE OR REPLACE TABLE _pi_bio_blackboard (slug TEXT PRIMARY KEY, note TEXT)"); // pre-create: clients' IF NOT EXISTS is a no-op
  await c.run(`CALL quack_serve('${ADDR}', token = '${TOKEN}')`);
  console.log(`  [server pid ${process.pid}] quack_serve up; owns the shared blackboard table`);
  await new Promise((r) => setTimeout(r, 7000));
  const rows = (await c.runAndReadAll("SELECT slug FROM _pi_bio_blackboard ORDER BY rowid")).getRows();
  console.log(`  [server] FINAL board (rows written by SEPARATE client processes): ${rows.map((r) => r[0]).join(", ")}`);
  c.closeSync(); inst.closeSync();
}

async function client(slug, deps) {
  const inst = await DuckDBInstance.create(":memory:"); // owns NO file — talks to the quack server
  const c = await inst.connect();
  await c.run("LOAD quack");
  await c.run(`CREATE SECRET (TYPE quack, TOKEN '${TOKEN}')`);
  await c.run(`ATTACH '${ADDR}' AS remote`);
  const bb = await sqlBlackboard(duckdbNodeConn(c), { table: TABLE, pollMs: 40, timeoutMs: 9000 });
  for (const d of deps) await bb.awaitNote(d); // BLOCK on each upstream note appearing on the shared board
  await bb.publish(slug, note(slug, `${slug}(${deps.join("+") || "root"})`));
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
  console.log("=== SHARED-WRITE BLACKBOARD: a decentralized pub/sub DAG across SEPARATE processes via quack ===\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1300)); // let the server bind
  // a diamond DAG, each step a SEPARATE process launched at once; they self-sequence via the shared board
  await Promise.all([
    spawnChild(["client", "extract", ""]),
    spawnChild(["client", "annotate", "extract"]),
    spawnChild(["client", "qc", "extract"]),
    spawnChild(["client", "classify", "annotate,qc"]),
  ]);
  await server;
  console.log("\nWhat it proves: four DISTINCT OS processes (distinct pids) coordinated a diamond DAG through ONE");
  console.log("shared mutable table on a quack server — no coordinator, no shared file handle. 'extract' published");
  console.log("first (the other three blocked on it via poll-SELECT), 'classify' last (it blocked on annotate+qc).");
  console.log("The pub/sub order emerged from the shared WRITES — topology x shared-writes, the last cell of the");
  console.log("matrix (chain / survey / pub-sub / push-pull / shared-write).");
}

const [mode, slug, depsCsv] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "client" ? client(slug, depsCsv ? depsCsv.split(",") : []) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
