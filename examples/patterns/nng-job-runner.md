# Remote worker status in the observation ledger


A coordinator owns the ledger and records a queued job. A separate
process reports `running` and `succeeded` through the same observation
API over DuckNNG RPC. The status slot is data; no second job-state
protocol is introduced.

``` ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../../dist/duckdb/observations.js";
import { resolveDucknngRuntime } from "../../scripts/ducknng-runtime.mjs";

const runId = "wgs-annotate-chr22";
const slot = `job:${runId}:status`;
const replayDigest = `sha256:${"a".repeat(64)}`;
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const server = await instance.connect();
await server.run(loadSql);
const conn = duckdbNodeConn(server);
await createBioObservationSchema(conn);
await conn.run(`INSERT INTO bio_observations
  (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
  VALUES (?, ?, ?, 'job_status', '"queued"', ?, 'job-store', ?)`,
  [randomUUID(), slot, `job:${runId}`, "2026-07-12T12:00:01Z", replayDigest]);
await server.run("SELECT ducknng_start_server('jobs', 'tcp://127.0.0.1:0', 1, 134217728, 300000, 0::UBIGINT)");
await server.run("SELECT ducknng_register_exec_method(false)");
const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='jobs'")).getRows()[0][0]);

const workerSource = `
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "./dist/duckdb/node-api.js";
import { createDucknngSqlConn } from "./dist/hosts/ducknng-sql-conn.js";
import { recordObservation } from "./dist/duckdb/observations.js";
import { resolveDucknngRuntime } from "./scripts/ducknng-runtime.mjs";
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const raw = await instance.connect();
await raw.run(loadSql);
const remote = createDucknngSqlConn({ client: duckdbNodeConn(raw), url: process.env.JOB_URL });
for (const [phase, recordedAt] of [["running", "2026-07-12T12:00:02Z"], ["succeeded", "2026-07-12T12:00:03Z"]]) {
  await recordObservation(remote, {
    statementKey: process.env.JOB_SLOT, subjectId: "job:wgs-annotate-chr22", predicate: "job_status",
    value: phase, recordedAt, source: "nng-worker-1", digest: process.env.JOB_DIGEST,
  });
}
process.stdout.write(JSON.stringify({ pid: process.pid, phases: ["running", "succeeded"] }));
raw.closeSync();
instance.closeSync();
`;
const worker = await new Promise((resolveWorker, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerSource], {
    cwd: process.cwd(),
    env: { ...process.env, JOB_URL: url, JOB_SLOT: slot, JOB_DIGEST: replayDigest },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveWorker(JSON.parse(stdout)) : reject(new Error(stderr)));
});

const current = await observationAsOfKey(conn, slot, "9999-12-31T23:59:59Z");
const history = await conn.all("SELECT value_json, digest, source FROM bio_observations WHERE statement_key = ? ORDER BY recorded_at", [slot]);
assert.equal(JSON.parse(current.value_json), "succeeded");
assert.deepEqual(history.map((row) => JSON.parse(row.value_json)), ["queued", "running", "succeeded"]);
assert.deepEqual([...new Set(history.map((row) => row.digest))], [replayDigest]);
piBio.json({ pattern: "remote-job-status", worker: { phases: worker.phases }, current: JSON.parse(current.value_json), history });
await server.run("SELECT ducknng_stop_server('jobs')");
server.closeSync();
instance.closeSync();
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "pattern": "remote-job-status",
  "worker": {
    "phases": [
      "running",
      "succeeded"
    ]
  },
  "current": "succeeded",
  "history": [
    {
      "value_json": "\"queued\"",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "source": "job-store"
    },
    {
      "value_json": "\"running\"",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "source": "nng-worker-1"
    },
    {
      "value_json": "\"succeeded\"",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "source": "nng-worker-1"
    }
  ]
}
```

</details>

This proves that a remote worker can use the ordinary temporal ledger
contract. It does not itself prove durable leases, retry, result
collection, or scheduler integration; those belong to the queue worker
and async-runner tests.
