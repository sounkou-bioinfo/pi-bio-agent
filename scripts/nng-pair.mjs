// RUNNABLE demo: the NNG **pair** topology (1:1 bidirectional) as a proposer↔verifier duo — the creative agent use
// of pair. Two SEPARATE processes hold a pair socket each over ipc: the PROPOSER offers a variant pathogenicity
// call; the VERIFIER (an adversarial critic) refutes-or-accepts in a tight back-and-forth until they converge. This
// is the 1:1 debate channel (distinct from survey's fan-out and blackboard's broadcast). It runs over ducknng's
// SQL socket layer — open_socket('pair') → listen/dial → send_socket_raw / recv_socket_raw_aio + aio_collect — the
// same convention ducknng's own conformance test uses. Run: `npm run build && node scripts/nng-pair.mjs`
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const URL_IPC = "ipc:///tmp/ducknng_pair_demo.ipc";
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const unhex = (h) => Buffer.from(h, "hex").toString("utf8");

async function conn() {
  const c = await (await DuckDBInstance.create(":memory:")).connect();
  await c.run("LOAD ducknng");
  return c;
}
const one = async (c, sql) => (await c.runAndReadAll(sql)).getRowObjects()[0];

async function openPair(c, role) {
  const id = (await one(c, "SELECT (ducknng_open_socket('pair')).socket_id AS id")).id;
  const sid = String(id); // BigInt -> text for interpolation
  if (role === "listen") await one(c, `SELECT (ducknng_listen_socket(${sid}, '${URL_IPC}', 134217728, 0::UBIGINT)).ok AS ok`);
  else await one(c, `SELECT (ducknng_dial_socket(${sid}, '${URL_IPC}', 2000, 0::UBIGINT)).ok AS ok`);
  return sid;
}
async function send(c, sid, obj) {
  await one(c, `SELECT (ducknng_send_socket_raw(${sid}::UBIGINT, from_hex('${hex(JSON.stringify(obj))}'), 3000)).ok AS ok`);
}
async function recv(c, sid) {
  const a = (await one(c, `SELECT ducknng_recv_socket_raw_aio(${sid}::UBIGINT, 6000) AS a`)).a;
  const r = await one(c, `SELECT ok, hex(frame) AS f FROM ducknng_aio_collect(list_value(${String(a)}::UBIGINT), 6000)`);
  return r?.f ? JSON.parse(unhex(r.f)) : null;
}

// the VERIFIER: an adversarial ACMG-ish critic. Accepts only when the call is supported by >=2 criteria at the
// right tier; otherwise refutes with what's missing. Deterministic so the demo is reproducible.
function critique(p) {
  const crit = p.evidence ?? [];
  if (p.call === "pathogenic" && crit.length < 2) return { verdict: "refine", why: "one criterion can't reach pathogenic — add a second (e.g. PM2 rarity)" };
  if (p.call === "likely_pathogenic" && crit.includes("PVS1") && crit.includes("PM2")) return { verdict: "accept", why: "PVS1 (LoF) + PM2 (rare) supports likely_pathogenic" };
  if (crit.length < 2) return { verdict: "refine", why: "insufficient evidence for any actionable call" };
  return { verdict: "accept", why: "supported" };
}

async function verifier() {
  const c = await conn();
  const sid = await openPair(c, "listen");
  console.log(`  [verifier pid ${process.pid}] pair socket listening`);
  for (let round = 1; round <= 5; round++) {
    const p = await recv(c, sid);
    if (!p) break;
    const v = critique(p);
    console.log(`  [verifier] round ${round}: proposal call=${p.call} evidence=[${(p.evidence ?? []).join(",")}] -> ${v.verdict.toUpperCase()} (${v.why})`);
    await send(c, sid, v);
    if (v.verdict === "accept") break;
  }
  await one(c, `SELECT ducknng_close_socket(${sid})`);
}

async function proposer() {
  const c = await conn();
  const sid = await openPair(c, "dial");
  await new Promise((r) => setTimeout(r, 150)); // let the pair connect
  // the proposer starts optimistic and DOWNGRADES as the verifier refutes — 1:1 convergence
  let proposal = { call: "pathogenic", conf: 0.9, evidence: ["PVS1"] };
  const ladder = [
    { call: "likely_pathogenic", conf: 0.7, evidence: ["PVS1", "PM2"] }, // the refinement after the first refute
  ];
  for (let round = 1; round <= 5; round++) {
    console.log(`  [proposer pid ${process.pid}] round ${round}: proposing call=${proposal.call} conf=${proposal.conf}`);
    await send(c, sid, proposal);
    const v = await recv(c, sid);
    if (!v) break;
    if (v.verdict === "accept") { console.log(`  [proposer] verifier ACCEPTED '${proposal.call}' — converged in ${round} round(s)`); break; }
    proposal = ladder.shift() ?? { ...proposal, call: "uncertain_significance", conf: 0.3 }; // downgrade on refute
  }
  await one(c, `SELECT ducknng_close_socket(${sid})`);
}

const spawnChild = (mode) => new Promise((res, rej) => {
  const ch = spawn(process.execPath, [fileURLToPath(import.meta.url), mode], { stdio: "inherit" });
  ch.on("close", (code) => (code === 0 ? res() : rej(new Error(`${mode} exit ${code}`))));
});

const mode = process.argv[2];
if (mode === "verifier") await verifier();
else if (mode === "proposer") await proposer();
else {
  console.log("=== NNG pair topology: a proposer↔verifier duo converges 1:1 (two SEPARATE processes) ===");
  const v = spawnChild("verifier");
  await new Promise((r) => setTimeout(r, 400)); // verifier listens first
  await spawnChild("proposer");
  await v;
  console.log("PROVED: a 1:1 pair channel carried an adversarial propose→refute→refine loop to convergence — the");
  console.log("debate topology, over ducknng's SQL socket layer (open_socket('pair') → listen/dial → send/recv).");
}
