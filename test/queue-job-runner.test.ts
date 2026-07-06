import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema } from "../src/duckdb/observations.js";
import { claimJob, createJobQueueSchema, readJobQueueRecord, recordJobClaimResult, recordJobClaimStatus } from "../src/hosts/job-queue.js";
import { queueJobRunner } from "../src/hosts/queue-job-runner.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(conn);
  await createJobQueueSchema(conn);
  let n = 0;
  const clock = () => `2026-07-01T00:00:${String(++n).padStart(2, "0")}Z`;
  return { conn, runner: queueJobRunner(conn, { clock }) };
}

describe("queueJobRunner: JobRunner over the durable queue", () => {
  test("submit enqueues a replay and status falls back to the queue before a worker reports", async () => {
    const { conn, runner } = await setup();
    await runner.submit({ runId: "qr1", replay: replay("qr1") });
    assert.equal((await runner.status("qr1"))?.phase, "queued");

    const claim = await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:00:10Z", leaseSeconds: 60 });
    assert.equal(claim?.runId, "qr1");
    assert.equal((await runner.status("qr1"))?.phase, "running", "queue phase is visible before ledger status exists");
  });

  test("ledger status/result win once a worker reports", async () => {
    const { conn, runner } = await setup();
    await runner.submit({ runId: "qr2", replay: replay("qr2") });
    const claim = await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:00:10Z", leaseSeconds: 60 });

    await recordJobClaimStatus(conn, {
      runId: "qr2",
      workerId: "w1",
      attempt: claim!.attempt,
      replayDigest: claim!.replayDigest,
      phase: "succeeded",
      recordedAt: "2026-07-01T00:00:12Z",
    });
    await recordJobClaimResult(conn, {
      runId: "qr2",
      workerId: "w1",
      attempt: claim!.attempt,
      replayDigest: claim!.replayDigest,
      result: { rows: [{ answer: 42 }] },
      recordedAt: "2026-07-01T00:00:13Z",
    });

    assert.equal((await runner.status("qr2"))?.phase, "succeeded");
    assert.deepEqual((await runner.collect("qr2"))?.result, { rows: [{ answer: 42 }] });
  });

  test("cancel marks the queue terminal and prevents later claims", async () => {
    const { conn, runner } = await setup();
    await runner.submit({ runId: "qr3", replay: replay("qr3") });
    await runner.cancel?.("qr3");

    const rec = await readJobQueueRecord(conn, "qr3");
    assert.equal(rec?.phase, "cancelled");
    assert.equal((await runner.collect("qr3"))?.phase, "cancelled");
    assert.equal(await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:10:00Z", leaseSeconds: 60 }), null);
  });
});
