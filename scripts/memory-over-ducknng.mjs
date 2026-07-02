// RUNNABLE smoke test: cross-process SHARED memory over a ducknng RPC server (the inter-process/agent/machine mode
// from docs/concurrency.md). A server process owns the ONE `bio_observations` store; two SEPARATE agent processes
// remember/recall through it over `ducknng_run_rpc` / `ducknng_query_rpc`, SEQUENTIALLY (A writes, then B reads).
// No agent opens the store file, so the process-exclusive-writer lock that stops concurrent FILE access never
// applies — agent:B (a different OS process) reads agent:A's memory, attributed. NOTE: this proves separate-process
// RPC *sharing*, NOT concurrent same-slug writes (those need server-side per-statement_key serialization — see
// docs/concurrency.md), nor persistent/inter-machine behavior (the server DB here is `:memory:`). The memory-store
// functions are reused UNCHANGED: they take a `SqlConn` that here routes over RPC. (Params are inlined into the RPC
// SQL string with escaping — the robust version is host code; this is a dogfood.)
// PREREQUISITE: the owned ducknng extension must be installed — `npm run provision:ducknng-owned` (else `LOAD
// ducknng` below fails on a clean host).
// Run: `npm run provision:ducknng-owned && npm run build && node scripts/memory-over-ducknng.mjs`  (imports ../dist)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema } from "../dist/duckdb/observations.js";
import { remember, recall, listMemory } from "../dist/hosts/memory-store.js";

// Unique-per-run address (avoids a fixed-port conflict): the supervisor derives it from its own pid and exports it
// so the spawned server + agent children inherit the SAME value via env. Falls back to a pid-derived port.
const ADDR = process.env.PI_BIO_MEM_ADDR ?? `tcp://127.0.0.1:${10000 + (process.pid % 50000)}`;
const T = "2026-07-02T00:00:00Z";

// inline SqlConn params into a plain SQL string (ducknng RPC sends a string, not bound params).
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const inline = (sql, params = []) => { let i = 0; return sql.replace(/\?/g, () => lit(params[i++])); };

// a SqlConn whose run/all route through the ducknng server — the client owns NO shared state, holds NO file lock.
function ducknngConn(local, url) {
  return {
    run: async (sql, params) => { await local.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${url}', ?, 0::UBIGINT)`, [inline(sql, params)]); },
    all: async (sql, params) => (await local.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${url}', ?, 0::UBIGINT)`, [inline(sql, params)])).getRowObjects(),
  };
}

async function serve() {
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  await createBioObservationSchema(duckdbNodeConn(c)); // the ONE store lives on the server
  await c.run(`SELECT ducknng_start_server('mem', '${ADDR}', 4, 134217728, 300000, 0::UBIGINT)`);
  await c.run("SELECT ducknng_register_exec_method(false)"); // exec opt-in — writes (remember) allowed, host boundary
  console.log(`  [server pid ${process.pid}] ducknng server owns the ONE bio_observations store`);
  await new Promise((r) => setTimeout(r, 9000));
  c.closeSync(); inst.closeSync();
}

async function agent(role, action) {
  const inst = await DuckDBInstance.create(":memory:"); // RPC-only; no shared file, no lock
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  const conn = ducknngConn(c, ADDR);
  if (action === "remember") {
    await remember(conn, { slug: "acmg-pvs1", kind: "memory_note", title: "PVS1", hook: "when classifying LoF", body: "null variant in a LoF gene", tags: [] }, T, role);
    console.log(`  [${role} pid ${process.pid}] REMEMBERED 'acmg-pvs1' through the server (no file opened)`);
  } else {
    const note = await recall(conn, "acmg-pvs1");
    const all = await listMemory(conn);
    console.log(`  [${role} pid ${process.pid}] RECALLED over RPC: ${note ? `'${note.slug}' = "${note.body}" by ${note.author}` : "(nothing)"} | list=${all.map((m) => m.slug).join(",")}`);
    if (!note || note.author !== "agent:A") { console.error("FAIL: agent:B did not read agent:A's attributed memory"); process.exit(1); }
    console.log("  SHOWN: a SEPARATE process read another agent's attributed memory over the server — no file lock (sequential A→B, not a concurrency test).");
  }
  c.closeSync(); inst.closeSync();
}

const spawnChild = (args) => new Promise((res, rej) => {
  const ch = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: "inherit" });
  ch.on("close", (code) => (code === 0 ? res() : rej(new Error(`child ${args.join(" ")} exit ${code}`))));
});

const mode = process.argv[2];
if (mode === "serve") await serve();
else if (mode === "agent") await agent(process.argv[3], process.argv[4]);
else {
  process.env.PI_BIO_MEM_ADDR = ADDR; // export so the spawned server + agents share this run's unique address
  console.log("=== cross-process shared memory over a ducknng server: server + two SEPARATE agent processes (sequential A→B) ===");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1500));
  await spawnChild(["agent", "agent:A", "remember"]);
  await spawnChild(["agent", "agent:B", "recall"]);
  await server;
  console.log("What it shows: the memory store ran on ONE ducknng server; two distinct OS processes shared it");
  console.log("(A wrote, then B read A's attributed note) — the SqlConn was RPC, no process opened the store file, so the");
  console.log("process-exclusive-writer lock never applied. This is separate-process RPC SHARING — NOT concurrent writes,");
  console.log("and NOT inter-machine/persistent (the server DB is :memory:).");
}
