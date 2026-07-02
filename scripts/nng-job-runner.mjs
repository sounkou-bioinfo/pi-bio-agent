import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../dist/duckdb/observations.js";

// DOGFOOD: distributed compute as a TOPOLOGY over the job ledger. A long-running job's status flows back over
// ducknng RPC into the SAME `job:<runId>:status` observation slot the job-store polls. The coordinator owns a
// shared DuckDB (the job ledger); a SEPARATE worker PROCESS runs the job and reports each phase by executing
// recordObservation-shaped SQL over `ducknng_run_rpc` against that shared db. The job-store code is UNCHANGED:
// only the dispatch and the worker are new, and the worker can be any language that speaks NNG (node here, R via
// nanonext/mirai, Python, …). This is the language-agnostic alternative to an SSH-to-SLURM / Modal backend, over
// our owned transport.
//
// Run:  npm run build && node scripts/nng-job-runner.mjs

const SELF = fileURLToPath(import.meta.url);
const URL = "tcp://127.0.0.1:9881";
const RUN_ID = "wgs-annotate-chr22";
const SLOT = `job:${RUN_ID}:status`;
const DIGEST = "sha256:" + "a".repeat(64); // stands in for the job's replaySpecDigest

async function serve() {
  const inst = await DuckDBInstance.create(":memory:");
  const raw = await inst.connect();
  await raw.run("LOAD ducknng");
  const conn = duckdbNodeConn(raw);
  await createBioObservationSchema(conn);                        // the job ledger (bio_observations)
  // the coordinator records the job QUEUED in its own ledger (the submit step)
  await conn.run(
    `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
     VALUES (?, ?, ?, 'job_status', '"queued"', ?, 'job-store', ?)`,
    [randomUUID(), SLOT, `job:${RUN_ID}`, new Date().toISOString(), DIGEST],
  );
  await raw.run(`SELECT ducknng_start_server('jobs', '${URL}', 1, 134217728, 300000, 0::UBIGINT)`);
  await raw.run("SELECT ducknng_register_exec_method(false)"); // EXEC OPT-IN: the host security boundary
  console.log(`  [coordinator pid ${process.pid}] job ledger up; '${RUN_ID}' recorded as queued`);
  await new Promise((r) => setTimeout(r, 6000)); // let the remote worker run + report
  // read the job's CURRENT status straight out of the shared slot (the same as-of read the job-store uses)
  const row = await observationAsOfKey(conn, SLOT, "9999-12-31T23:59:59Z");
  console.log(`  [coordinator] '${RUN_ID}' final status, read back from the shared slot: ${JSON.parse(row.value_json)}`);
  raw.closeSync(); inst.closeSync();
}

async function worker(label) {
  const inst = await DuckDBInstance.create(":memory:"); // owns NO ledger, only talks RPC
  const raw = await inst.connect();
  await raw.run("LOAD ducknng");
  const report = async (phase) => {
    const at = new Date().toISOString();
    const sql =
      `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest) ` +
      `VALUES ('${randomUUID()}', '${SLOT}', 'job:${RUN_ID}', 'job_status', '${JSON.stringify(JSON.stringify(phase))}', '${at}', '${label}', '${DIGEST}')`;
    await raw.run(`SELECT * FROM ducknng_run_rpc('${URL}', ?, 0::UBIGINT)`, [sql]);
    console.log(`  [worker ${label} pid ${process.pid}] reported '${phase}' over ducknng RPC`);
  };
  await report("running");
  await new Promise((r) => setTimeout(r, 400)); // ... the actual long compute would happen here (R/py/samtools/VEP) ...
  await report("succeeded");
  raw.closeSync(); inst.closeSync();
}

function spawnChild(args) {
  return new Promise((resolve, reject) => {
    const ch = spawn(process.execPath, [SELF, ...args], { stdio: ["ignore", "inherit", "inherit"] });
    ch.on("error", reject);
    ch.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`))));
  });
}

async function orchestrate() {
  console.log("Distributed compute over ducknng: a separate worker reports job status into the shared ledger\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1500)); // let the coordinator bind + register exec
  await spawnChild(["worker", "nng-worker-1"]); // a separate process; could equally be an R (nanonext) worker
  await server;
  console.log("\nA SEPARATE worker process wrote the job's status (running, then succeeded) into the coordinator's");
  console.log("job:<id>:status slot over ducknng RPC, and the coordinator read it back with the same as-of query it");
  console.log("uses for any observation. The job-store code did not change, and the worker can be any language that");
  console.log("speaks NNG. A language-agnostic distributed backend over our owned transport, not an opaque runtime.");
}

const [mode, label] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "worker" ? worker(label) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
