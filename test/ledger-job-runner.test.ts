import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, recordObservation } from "../src/duckdb/observations.js";
import { ledgerJobRunner, type JobDispatch } from "../src/hosts/ledger-job-runner.js";
import { submitBioJob, pollBioJob, resumeBioJob } from "../src/hosts/job-store.js";
import type { SqlConn } from "../src/core/ports.js";
import { replaySpecDigest, type RunReplaySpec } from "../src/core/reproducibility.js";

// The DISTRIBUTED JobRunner: status/result live in the shared observation ledger; a remote worker (any language,
// any transport) reports its phase into the job:<runId>:status slot. Here the injected `dispatch` simulates that
// worker by writing the same rows a real ducknng-RPC worker would (scripts/nng-job-runner.mjs does it for real).
const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });
const ducknngAvailable = await (async () => {
  let inst: DuckDBInstance | undefined;
  let c: Awaited<ReturnType<DuckDBInstance["connect"]>> | undefined;
  try {
    inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    c = await inst.connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch {
    return false;
  } finally {
    c?.closeSync();
    inst?.closeSync();
  }
})();

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(conn);
  return conn;
}

// a dispatch that plays the role of a remote worker: it reports running then succeeded (+ a result) into the slot,
// exactly as an R/Python/node worker would over ducknng RPC.
function workerDispatch(conn: SqlConn, result: unknown): JobDispatch {
  return async (spec) => {
    const rec = (slot: string, value: unknown, at: string) => recordObservation(conn, { statementKey: slot, subjectId: `job:${spec.runId}`, predicate: "job_status", value, recordedAt: at, source: "nng-worker" });
    await rec(`job:${spec.runId}:status`, "running", "2026-07-01T00:00:02Z");
    await rec(`job:${spec.runId}:status`, "succeeded", "2026-07-01T00:00:03Z");
    await recordObservation(conn, { statementKey: `job:${spec.runId}:result`, subjectId: `job:${spec.runId}`, predicate: "job_result", value: result, recordedAt: "2026-07-01T00:00:03Z", source: "nng-worker" });
  };
}

const duckdbStringLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

function assertRpcText(label: string, value: string, pattern: RegExp): void {
  assert.match(value, pattern, `${label} is intentionally fixture-shaped before interpolation into ducknng_run_rpc SQL`);
}

function remoteObservationInsertSql(spec: { runId: string; slot: string; predicate: string; value: unknown; at: string; source: string; digest: string }): string {
  assertRpcText("runId", spec.runId, /^[A-Za-z0-9._:-]{1,128}$/);
  assertRpcText("slot", spec.slot, /^job:[A-Za-z0-9._:-]{1,128}:(status|result)$/);
  assertRpcText("predicate", spec.predicate, /^job_(status|result)$/);
  assertRpcText("source", spec.source, /^[A-Za-z0-9._:-]{1,128}$/);
  assertRpcText("digest", spec.digest, /^sha256:[0-9a-f]{64}$/);
  assertRpcText("recorded_at", spec.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const valueJson = JSON.stringify(spec.value);
  assert.doesNotThrow(() => JSON.parse(valueJson), "remote observation value must be JSON before it is embedded in RPC SQL");
  assert.ok(Number.isFinite(new Date(spec.at).getTime()), "remote observation recorded_at must be parseable before it is embedded in RPC SQL");
  const payload = JSON.stringify({
    statement_key: spec.slot,
    subject_id: `job:${spec.runId}`,
    predicate: spec.predicate,
    value: spec.value,
    recorded_at: spec.at,
    source: spec.source,
    digest: spec.digest,
  });
  assert.doesNotThrow(() => JSON.parse(payload), "remote observation payload must be JSON before it is embedded in RPC SQL");
  // ducknng_run_rpc transports a SQL string to the server. Keep the RPC data path to one local-controlled JSON
  // payload, then force the server to parse JSON/timestamps before insert.
  return `WITH payload AS (
      SELECT CAST(${duckdbStringLiteral(payload)} AS JSON) AS j
    ),
    checked AS (
      SELECT
        json_extract_string(j, '$.statement_key') AS statement_key,
        json_extract_string(j, '$.subject_id') AS subject_id,
        json_extract_string(j, '$.predicate') AS predicate,
        CAST(json_extract(j, '$.value') AS JSON) AS value_json,
        json_extract_string(j, '$.recorded_at') AS recorded_at,
        CAST(json_extract_string(j, '$.recorded_at') AS TIMESTAMPTZ) AS recorded_at_check,
        json_extract_string(j, '$.source') AS source,
        json_extract_string(j, '$.digest') AS digest
      FROM payload
    )
    INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, value_json, recorded_at, source, digest)
    SELECT
      'rpc:' || CAST(uuid() AS VARCHAR),
      checked.statement_key,
      checked.subject_id,
      checked.predicate,
      checked.value_json,
      checked.recorded_at,
      checked.source,
      checked.digest
    FROM checked
    WHERE checked.recorded_at_check IS NOT NULL`;
}

async function startDucknngLedger(): Promise<{
  conn: SqlConn;
  url: string;
  close(): Promise<void>;
}> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const raw = await inst.connect();
  await raw.run("LOAD ducknng");
  const conn = duckdbNodeConn(raw);
  await createBioObservationSchema(conn);
  const name = `jobs_${randomUUID().replace(/-/g, "_")}`;
  assertRpcText("server name", name, /^jobs_[0-9a-f_]+$/);
  await raw.run(`SELECT ducknng_start_server(${duckdbStringLiteral(name)}, 'tcp://127.0.0.1:0', 1, 134217728, 300000, 0::UBIGINT)`);
  await raw.run("SELECT ducknng_register_exec_method(false)");
  const url = String((await raw.runAndReadAll(`SELECT listen FROM ducknng_list_servers() WHERE name = ${duckdbStringLiteral(name)}`)).getRows()[0]![0]);
  return {
    conn,
    url,
    close: async () => {
      let stopError: unknown;
      try {
        await raw.run(`SELECT ducknng_stop_server(${duckdbStringLiteral(name)})`);
      } catch (e) {
        stopError = e;
      } finally {
        raw.closeSync();
        inst.closeSync();
      }
      if (stopError) throw stopError;
    },
  };
}

function ducknngRpcWorker(url: string): JobDispatch {
  let client: Awaited<ReturnType<typeof startDucknngClientWithUrl>> | undefined;
  const remoteInsert = async (sql: string): Promise<void> => {
    if (!client) client = await startDucknngClientWithUrl(url);
    await client.run(sql);
  };
  const insertObservation = async (spec: { runId: string; slot: string; predicate: string; value: unknown; at: string; source: string; digest: string }): Promise<void> => {
    await remoteInsert(remoteObservationInsertSql(spec));
  };
  const dispatch: JobDispatch = async (spec) => {
    const digest = replaySpecDigest(spec.replay);
    await insertObservation({
      runId: spec.runId,
      slot: `job:${spec.runId}:status`,
      predicate: "job_status",
      value: { phase: "running", progress: { current: 1, total: 2, unit: "rpc-status" }, message: "worker accepted over ducknng RPC" },
      at: "2026-07-01T00:00:02Z",
      source: "ducknng-worker",
      digest,
    });
    await insertObservation({
      runId: spec.runId,
      slot: `job:${spec.runId}:status`,
      predicate: "job_status",
      value: "succeeded",
      at: "2026-07-01T00:00:03Z",
      source: "ducknng-worker",
      digest,
    });
    await insertObservation({
      runId: spec.runId,
      slot: `job:${spec.runId}:result`,
      predicate: "job_result",
      value: { schema: "pi-bio.job_result.v1", result: { rows: [{ answer: 42 }], worker: "ducknng-rpc" } },
      at: "2026-07-01T00:00:03Z",
      source: "ducknng-worker",
      digest,
    });
  };
  Object.assign(dispatch, { close: () => client?.close() });
  return dispatch;
}

async function startDucknngClientWithUrl(url: string): Promise<{
  run(sql: string): Promise<void>;
  close(): void;
}> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const raw = await inst.connect();
  await raw.run("LOAD ducknng");
  return {
    async run(sql: string): Promise<void> {
      const row = (await raw.runAndReadAll("SELECT * FROM ducknng_run_rpc(?, ?, 0::UBIGINT)", [url, sql])).getRowObjects()[0] as { ok?: boolean; error?: string };
      assert.equal(row.ok, true, row.error ?? "ducknng_run_rpc failed");
    },
    close: () => {
      raw.closeSync();
      inst.closeSync();
    },
  };
}

describe("ledgerJobRunner: distributed JobRunner whose status is data in the shared ledger", () => {
  test("submit dispatches; status/collect read the worker's reports from the slot", async () => {
    const conn = await setup();
    const runner = ledgerJobRunner(conn, workerDispatch(conn, { rows: [{ answer: 42 }] }));
    await runner.submit({ runId: "d1", replay: replay("d1") });
    const st = await runner.status("d1");
    assert.equal(st!.phase, "succeeded", "the runner reads the remote worker's phase from the ledger");
    const res = await runner.collect("d1");
    assert.deepEqual(res, { runId: "d1", phase: "succeeded", result: { rows: [{ answer: 42 }] } });
  });

  test("drops into the job-store UNCHANGED: pollBioJob sees the worker's already-recorded phase, no double-record", async () => {
    const conn = await setup();
    // dispatch runs during submitBioJob -> the worker writes running/succeeded into the slot
    const runner = ledgerJobRunner(conn, workerDispatch(conn, { ok: true }));
    // submitBioJob records queued at T1 (before the worker's T2/T3), then dispatches (worker reports)
    const cwd = await (await import("node:fs")).promises.mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "pi-bio-ledger-"));
    await submitBioJob(conn, runner, { cwd, runId: "d2", replay: replay("d2"), now: "2026-07-01T00:00:01Z" });
    const before = (await conn.all<{ n: bigint }>(`SELECT count(*) n FROM bio_observations WHERE statement_key = 'job:d2:status'`))[0].n;
    const st = await pollBioJob(conn, runner, { cwd, runId: "d2", now: "2026-07-01T00:00:09Z" });
    assert.equal(st.phase, "succeeded");
    const after = (await conn.all<{ n: bigint }>(`SELECT count(*) n FROM bio_observations WHERE statement_key = 'job:d2:status'`))[0].n;
    assert.equal(Number(after), Number(before), "poll did not double-record — the worker already owns the slot");
  });

  test("submit does NOT regress a fast worker: if dispatch already reported running, no queued row is written", async () => {
    const conn = await setup();
    // a worker that reports 'running' synchronously during dispatch (before submit records queued)
    const dispatch: JobDispatch = async (spec) => {
      await recordObservation(conn, { statementKey: `job:${spec.runId}:status`, subjectId: `job:${spec.runId}`, predicate: "job_status", value: "running", recordedAt: "2026-07-01T00:00:02Z", source: "fast-worker" });
    };
    const runner = ledgerJobRunner(conn, dispatch);
    const cwd = await (await import("node:fs")).promises.mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "pi-bio-ledger-"));
    const st = await submitBioJob(conn, runner, { cwd, runId: "f1", replay: replay("f1"), now: "2026-07-01T00:00:09Z" });
    assert.equal(st.phase, "running", "submit returns the worker's already-reported phase, not queued");
    const rows = (await conn.all<{ v: string }>(`SELECT value_json v FROM bio_observations WHERE statement_key='job:f1:status'`)).map((r) => JSON.parse(r.v));
    assert.deepEqual(rows, ["running"], "only the worker's 'running' row exists — no queued regression at the later submit time");
  });

  test("a bare result that LOOKS like an envelope ({result:…}) is not misread — only the schema-tagged envelope is", async () => {
    const conn = await setup();
    // a worker writes succeeded + a BARE result value that happens to be an object with a `result` key
    const bareResult = { result: "this is the actual answer", note: "not an envelope" };
    const dispatch: JobDispatch = async (spec) => {
      const rec = (slot: string, value: unknown, at: string) => recordObservation(conn, { statementKey: slot, subjectId: `job:${spec.runId}`, predicate: "job_status", value, recordedAt: at, source: "worker" });
      await rec(`job:${spec.runId}:status`, "succeeded", "2026-07-01T00:00:03Z");
      await recordObservation(conn, { statementKey: `job:${spec.runId}:result`, subjectId: `job:${spec.runId}`, predicate: "job_result", value: bareResult, recordedAt: "2026-07-01T00:00:03Z", source: "worker" });
    };
    const runner = ledgerJobRunner(conn, dispatch);
    await runner.submit({ runId: "b1", replay: replay("b1") });
    const res = await runner.collect("b1");
    assert.deepEqual(res!.result, bareResult, "the whole bare value is the result — NOT reinterpreted as an envelope's .result");
  });

  test("fail closed: submit rejects a replay whose runId does not match", async () => {
    const conn = await setup();
    const runner = ledgerJobRunner(conn, async () => {});
    await assert.rejects(() => runner.submit({ runId: "d3", replay: replay("OTHER") }), /replay.runId .* must match/);
  });
});

describe("ledgerJobRunner over real ducknng RPC", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  test("a separate ducknng client reports status/result into the shared job ledger", async () => {
    const server = await startDucknngLedger();
    const dispatch = ducknngRpcWorker(server.url) as JobDispatch & { close?: () => void };
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-nng-job-"));
    const runId = "rpc-job-1";
    const runner = ledgerJobRunner(server.conn, dispatch);

    try {
      const submitted = await submitBioJob(server.conn, runner, { cwd, runId, replay: replay(runId), now: "2026-07-01T00:00:01Z", source: "coordinator" });
      assert.equal(submitted.phase, "succeeded", "fast RPC worker status wins over queued");
      const polled = await pollBioJob(server.conn, runner, { cwd, runId, now: "2026-07-01T00:00:04Z", source: "coordinator" });
      assert.equal(polled.phase, "succeeded");
      const resumed = await resumeBioJob(server.conn, { cwd, runId });
      assert.equal(resumed.phase, "succeeded");
      assert.deepEqual(await runner.collect(runId), {
        runId,
        phase: "succeeded",
        result: { rows: [{ answer: 42 }], worker: "ducknng-rpc" },
      });

      const statusRows = await server.conn.all<{ v: string }>(
        `SELECT value_json AS v FROM bio_observations WHERE statement_key = 'job:${runId}:status' ORDER BY recorded_at`,
      );
      assert.deepEqual(statusRows.map((row) => JSON.parse(row.v)), [
        { phase: "running", progress: { current: 1, total: 2, unit: "rpc-status" }, message: "worker accepted over ducknng RPC" },
        "succeeded",
      ]);
      const digests = await server.conn.all<{ digest: string }>(
        `SELECT DISTINCT digest FROM bio_observations WHERE statement_key IN ('job:${runId}:status', 'job:${runId}:result') ORDER BY digest`,
      );
      assert.deepEqual(digests.map((row) => row.digest), [resumed.replayDigest], "RPC worker rows carry the durable replay digest");
    } finally {
      dispatch.close?.();
      await server.close();
    }
  });
});
