// RUNNABLE demo: the NNG **survey** topology (surveyor/respondent) as a MULTI-PROVIDER JURY — the creative,
// provider-agnostic agent use. A surveyor process broadcasts one question ("classify this variant") to N
// respondent processes (each a different "provider" — a distinct judgment rule standing in for Claude / GPT / a
// deterministic-SQL responder); the surveyor fans-in their answers and takes a QUORUM, abstaining when they
// disagree (our grounding doctrine). This is fan-out+fan-in — distinct from pair's 1:1 and blackboard's broadcast.
// Over ducknng's SQL socket layer: open_socket('surveyor'|'respondent') → listen/dial → send/recv_aio + aio_collect.
// Run: `npm run build && node scripts/nng-survey.mjs`
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const URL_IPC = "ipc:///tmp/ducknng_survey_demo.ipc";
const N = 3;
const hex = (s) => Buffer.from(s, "utf8").toString("hex");
const unhex = (h) => Buffer.from(h, "hex").toString("utf8");

async function conn() { const c = await (await DuckDBInstance.create(":memory:")).connect(); await c.run("LOAD ducknng"); return c; }
const one = async (c, sql) => (await c.runAndReadAll(sql)).getRowObjects()[0];

async function openSock(c, proto, role) {
  const sid = String((await one(c, `SELECT (ducknng_open_socket('${proto}')).socket_id AS id`)).id);
  if (role === "listen") await one(c, `SELECT (ducknng_listen_socket(${sid}, '${URL_IPC}', 134217728, 0::UBIGINT)).ok AS ok`);
  else await one(c, `SELECT (ducknng_dial_socket(${sid}, '${URL_IPC}', 2000, 0::UBIGINT)).ok AS ok`);
  return sid;
}
const send = async (c, sid, obj) => one(c, `SELECT (ducknng_send_socket_raw(${sid}::UBIGINT, from_hex('${hex(JSON.stringify(obj))}'), 3000)).ok AS ok`);
async function recv(c, sid, ms) {
  const a = (await one(c, `SELECT ducknng_recv_socket_raw_aio(${sid}::UBIGINT, ${ms}) AS a`)).a;
  const r = await one(c, `SELECT ok, hex(frame) AS f FROM ducknng_aio_collect(list_value(${String(a)}::UBIGINT), ${ms})`);
  return r?.ok && r.f ? JSON.parse(unhex(r.f)) : null;
}

// each respondent is a distinct "provider": a rule that maps evidence -> a call. Deterministic so the demo is reproducible.
const PROVIDERS = {
  "provider-A": (ev) => (ev.includes("PVS1") && ev.includes("PM2") ? "likely_pathogenic" : "uncertain_significance"),
  "provider-B": (ev) => (ev.includes("PVS1") ? "likely_pathogenic" : "uncertain_significance"),          // more lenient
  "provider-C": (ev) => (ev.length >= 3 ? "pathogenic" : "uncertain_significance"),                        // stricter/different axis
};

async function respondent(name) {
  const c = await conn();
  const sid = await openSock(c, "respondent", "dial");
  const survey = await recv(c, sid, 6000); // block for the surveyor's question
  if (survey) {
    const call = PROVIDERS[name](survey.evidence ?? []);
    console.log(`  [${name} pid ${process.pid}] answered '${call}'`);
    await send(c, sid, { provider: name, call });
  }
  await one(c, `SELECT ducknng_close_socket(${sid})`);
}

async function surveyor() {
  const c = await conn();
  const sid = await openSock(c, "surveyor", "listen");
  await new Promise((r) => setTimeout(r, 700)); // let respondents dial in
  console.log(`  [surveyor pid ${process.pid}] surveying ${N} providers: classify variant (evidence PVS1,PM2)`);
  await send(c, sid, { question: "classify", evidence: ["PVS1", "PM2"] }); // broadcast to all respondents
  const votes = [];
  for (let i = 0; i < N; i++) { const resp = await recv(c, sid, 4000); if (resp) { console.log(`  [surveyor] <- ${resp.provider}: ${resp.call}`); votes.push(resp.call); } }
  // AGGREGATE: majority with a quorum; abstain on no majority (deterministic reduce over the jury)
  const tally = votes.reduce((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {});
  const [top, count] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? ["(none)", 0];
  const verdict = count > N / 2 ? top : "ABSTAIN (no quorum)";
  console.log(`  [surveyor] tally=${JSON.stringify(tally)} -> JURY VERDICT: ${verdict}`);
  await one(c, `SELECT ducknng_close_socket(${sid})`);
  if (!(count > N / 2)) { console.error("demo expected a quorum"); process.exit(1); }
}

const spawnChild = (mode, arg) => new Promise((res, rej) => {
  const ch = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, arg ?? ""], { stdio: "inherit" });
  ch.on("close", (code) => (code === 0 ? res() : rej(new Error(`${mode} exit ${code}`))));
});

const mode = process.argv[2];
if (mode === "surveyor") await surveyor();
else if (mode === "respondent") await respondent(process.argv[3]);
else {
  console.log(`=== NNG survey topology: a surveyor polls ${N} provider processes and takes a quorum ===`);
  const s = spawnChild("surveyor");
  await new Promise((r) => setTimeout(r, 300));
  await Promise.all(Object.keys(PROVIDERS).map((name) => spawnChild("respondent", name)));
  await s;
  console.log("PROVED: one surveyor fanned a question out to N separate provider processes and reduced their");
  console.log("answers to a quorum verdict (abstaining on no majority) — the provider-agnostic jury, over ducknng.");
}
