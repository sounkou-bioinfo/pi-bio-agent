import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../dist/duckdb/observations.js";

// DOGFOOD: the JobRunner NNG COMPUTE PROFILE — a long-running job's status flows back over ducknng RPC into the
// SAME `job:<runId>:status` observation slot the L1 job-store already polls. The coordinator owns a shared DuckDB
// (the job ledger); a SEPARATE worker PROCESS executes the job and reports each phase by running recordObservation-
// shaped SQL over `ducknng_run_rpc` against that shared db. The job-store code is UNCHANGED — only dispatch + the
// worker are new, and the worker can be ANY language that speaks NNG: node here, R via nanonext/mirai, Python via
// pynng. This is the native, language-agnostic alternative to an SSH-SLURM / Modal backend, over our OWNED transport.
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
  // the coordinator records the job QUEUED in its own ledger (the L1 submit step)
  await conn.run(
    `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
     VALUES (?, ?, ?, 'job_status', '"queued"', ?, 'job-store', ?)`,
    [randomUUID(), SLOT, `job:${RUN_ID}`, new Date().toISOString(), DIGEST],
  );
  await raw.run(`SELECT ducknng_start_server('jobs', '${URL}', 1, 134217728, 300000, 0::UBIGINT)`);
  await raw.run("SELECT ducknng_register_exec_method(false)"); // EXEC OPT-IN — the host security boundary
  console.log(`  [coordinator pid ${process.pid}] shared job ledger up; ${RUN_ID} recorded queued`);
  await new Promise((r) => setTimeout(r, 6000)); // let the remote worker run + report
  // read the job's CURRENT status straight out of the shared slot — the SAME L1 as-of read
  const row = await observationAsOfKey(conn, SLOT, "9999-12-31T23:59:59Z");
  console.log(`  [coordinator] ${RUN_ID} FINAL status (reported by a SEPARATE worker process over ducknng RPC): ${JSON.parse(row.value_json)}`);
  raw.closeSync(); inst.closeSync();
}

async function worker(label) {
  const inst = await DuckDBInstance.create(":memory:"); // owns NO ledger — only talks RPC
  const raw = await inst.connect();
  await raw.run("LOAD ducknng");
  const report = async (phase) => {
    const at = new Date().toISOString();
    const sql =
      `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest) ` +
      `VALUES ('${randomUUID()}', '${SLOT}', 'job:${RUN_ID}', 'job_status', '${JSON.stringify(JSON.stringify(phase))}', '${at}', '${label}', '${DIGEST}')`;
    await raw.run(`SELECT * FROM ducknng_run_rpc('${URL}', ?, 0::UBIGINT)`, [sql]);
    console.log(`  [worker ${label} pid ${process.pid}] reported ${phase} over ducknng RPC`);
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
  console.log("=== JobRunner NNG compute profile: a remote worker reports job status over ducknng RPC into the L1 slot ===\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1500)); // let the coordinator bind + register exec
  await spawnChild(["worker", "nng-worker-1"]); // a separate process — could be an R (nanonext) or Python (pynng) worker
  await server;
  console.log("\nWhat it proves: a long-running job's status (running -> succeeded) was written by a SEPARATE worker");
  console.log("process into the coordinator's job:<runId>:status slot over ducknng RPC — and read back by the SAME");
  console.log("L1 observationAsOfKey. The job-store did not change; the worker is language-agnostic (node/R/python).");
  console.log("This is the native distributed-compute backend for the JobRunner over our owned NNG transport.");
}

const [mode, label] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "worker" ? worker(label) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
