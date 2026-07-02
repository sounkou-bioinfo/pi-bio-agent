import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, recordObservation } from "../src/duckdb/observations.js";
import { ledgerJobRunner, type JobDispatch } from "../src/hosts/ledger-job-runner.js";
import { submitBioJob, pollBioJob } from "../src/hosts/job-store.js";
import type { SqlConn } from "../src/core/ports.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

// The DISTRIBUTED JobRunner: status/result live in the shared observation ledger; a remote worker (any language,
// any transport) reports its phase into the job:<runId>:status slot. Here the injected `dispatch` simulates that
// worker by writing the same rows a real ducknng-RPC worker would (scripts/nng-job-runner.mjs does it for real).
const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });

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
