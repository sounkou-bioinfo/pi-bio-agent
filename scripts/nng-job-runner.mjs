import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../dist/duckdb/observations.js";

// Dogfood: distributed compute as a topology over the job ledger. A long-running job's status flows back over
// ducknng RPC into the same `job:<runId>:status` observation slot the job-store polls. The coordinator owns a
// shared DuckDB ledger; a separate worker process reports each phase by executing recordObservation-shaped SQL over
// `ducknng_run_rpc` against that shared DB. The job-store code does not change. Only dispatch and the worker are
// new, and the worker can be any language that speaks NNG (Node here, R via nanonext/mirai, Python, ...).
//
// Run:  npm run build && node scripts/nng-job-runner.mjs

const SELF = fileURLToPath(import.meta.url);
const RUN_ID = "wgs-annotate-chr22";
const SLOT = `job:${RUN_ID}:status`;
const DIGEST = "sha256:" + "a".repeat(64); // stands in for the job's replaySpecDigest
const FUTURE = "9999-12-31T23:59:59Z";

const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

function remoteStatusInsertSql({ phase, at, source }) {
  assert.match(phase, /^(running|succeeded)$/);
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(source, /^[A-Za-z0-9._:-]{1,128}$/);
  const payload = JSON.stringify({
    statement_key: SLOT,
    subject_id: `job:${RUN_ID}`,
    predicate: "job_status",
    value: phase,
    recorded_at: at,
    source,
    digest: DIGEST,
  });
  return `WITH payload AS (
      SELECT CAST(${sqlString(payload)} AS JSON) AS j
    ),
    checked AS (
      SELECT
        json_extract_string(j, '$.statement_key') AS statement_key,
        json_extract_string(j, '$.subject_id') AS subject_id,
        json_extract_string(j, '$.predicate') AS predicate,
        CAST(json_extract(j, '$.value') AS JSON) AS value_json,
        json_extract_string(j, '$.recorded_at') AS recorded_at_text,
        CAST(json_extract_string(j, '$.recorded_at') AS TIMESTAMPTZ) AS recorded_at,
        json_extract_string(j, '$.source') AS source,
        json_extract_string(j, '$.digest') AS digest
      FROM payload
    )
    INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
    SELECT 'rpc:' || CAST(uuid() AS VARCHAR), statement_key, subject_id, predicate, value_json, recorded_at_text, source, digest
    FROM checked
    WHERE recorded_at IS NOT NULL`;
}

async function serve(url) {
  const inst = await DuckDBInstance.create(":memory:");
  const raw = await inst.connect();
  let serverStarted = false;
  let bodyError;
  try {
    await raw.run("LOAD ducknng");
    const conn = duckdbNodeConn(raw);
    await createBioObservationSchema(conn);                        // the job ledger (bio_observations)
    // the coordinator records the job QUEUED in its own ledger (the submit step)
    await conn.run(
      `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
       VALUES (?, ?, ?, 'job_status', '"queued"', ?, 'job-store', ?)`,
      [randomUUID(), SLOT, `job:${RUN_ID}`, "2026-07-01T00:00:01Z", DIGEST],
    );
    await raw.run(`SELECT ducknng_start_server('jobs', ${sqlString(url)}, 1, 134217728, 300000, 0::UBIGINT)`);
    serverStarted = true;
    await raw.run("SELECT ducknng_register_exec_method(false)"); // EXEC OPT-IN: the host security boundary
    console.log(`  [coordinator pid ${process.pid}] job ledger up at ${url}; '${RUN_ID}' recorded as queued`);
    await new Promise((r) => setTimeout(r, 2500)); // let the remote worker run + report
    // read the job's CURRENT status straight out of the shared slot (the same as-of read the job-store uses)
    const row = await observationAsOfKey(conn, SLOT, FUTURE);
    assert.ok(row?.value_json, "coordinator saw a final job status");
    assert.equal(JSON.parse(row.value_json), "succeeded");
    const rows = await conn.all(
      "SELECT value_json, digest FROM bio_observations WHERE statement_key = ? ORDER BY recorded_at",
      [SLOT],
    );
    assert.deepEqual(rows.map((r) => JSON.parse(r.value_json)), ["queued", "running", "succeeded"]);
    assert.deepEqual([...new Set(rows.map((r) => r.digest))], [DIGEST]);
    console.log(`  [coordinator] '${RUN_ID}' final status, read back from the shared slot: ${JSON.parse(row.value_json)}`);
  } catch (e) {
    bodyError = e;
    throw e;
  } finally {
    let stopError;
    if (serverStarted) {
      try {
        await raw.run("SELECT ducknng_stop_server('jobs')");
      } catch (e) {
        stopError = e;
      }
    }
    raw.closeSync();
    inst.closeSync();
    if (stopError && bodyError === undefined) throw stopError;
  }
}

async function worker(label, url) {
  const inst = await DuckDBInstance.create(":memory:"); // owns NO ledger, only talks RPC
  const raw = await inst.connect();
  try {
    await raw.run("LOAD ducknng");
    const report = async (phase, at) => {
      const sql = remoteStatusInsertSql({ phase, at, source: label });
      const row = (await raw.runAndReadAll("SELECT * FROM ducknng_run_rpc(?, ?, 0::UBIGINT)", [url, sql])).getRowObjects()[0] ?? {};
      assert.equal(row.ok, true, row.error ?? "ducknng_run_rpc failed");
      console.log(`  [worker ${label} pid ${process.pid}] reported '${phase}' over ducknng RPC`);
    };
    await report("running", "2026-07-01T00:00:02Z");
    await new Promise((r) => setTimeout(r, 400)); // ... the actual long compute would happen here (R/py/samtools/VEP) ...
    await report("succeeded", "2026-07-01T00:00:03Z");
  } finally {
    raw.closeSync();
    inst.closeSync();
  }
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
  const path = join(tmpdir(), `pi-bio-nng-job-${process.pid}-${randomUUID()}.ipc`);
  const url = `ipc://${path}`;
  const server = spawnChild(["serve", url]);
  await new Promise((r) => setTimeout(r, 1500)); // let the coordinator bind + register exec
  try {
    await spawnChild(["worker", "nng-worker-1", url]); // a separate process; could equally be an R (nanonext) worker
    await server;
  } finally {
    await rm(path, { force: true });
  }
  console.log("\nA separate worker process wrote the job's status (running, then succeeded) into the coordinator's");
  console.log("job:<id>:status slot over ducknng RPC, and the coordinator read it back with the same as-of query it");
  console.log("uses for any observation. The job-store code did not change, and the worker can be any language that");
  console.log("speaks NNG. ducknng RPC keeps status as queryable ledger data.");
}

const [mode, label, url] = process.argv.slice(2);
const run = mode === "serve" ? serve(label) : mode === "worker" ? worker(label, url) : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
