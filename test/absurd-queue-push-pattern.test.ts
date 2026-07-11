import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { RunReplaySpec } from "../src/core/reproducibility.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey, recordObservation } from "../src/duckdb/observations.js";
import { claimJob, createJobQueueSchema, finishJobClaim, readJobQueueRecord, recordJobClaimResult, recordJobClaimStatus } from "../src/hosts/job-queue.js";
import { queueJobRunner } from "../src/hosts/queue-job-runner.js";

const ducknngAvailable = await (async () => {
  try {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const c = await inst.connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    c.closeSync();
    inst.closeSync();
    return true;
  } catch {
    return false;
  }
})();

const FUTURE = "9999-12-31T23:59:59.999Z";
const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");
const unhex = (h: string): string => Buffer.from(h, "hex").toString("utf8");
const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1 AS answer" });

async function setupQueue() {
  const inst = await DuckDBInstance.create(":memory:");
  const raw = await inst.connect();
  const conn = duckdbNodeConn(raw);
  await createBioObservationSchema(conn);
  await createJobQueueSchema(conn);
  let tick = 0;
  const runner = queueJobRunner(conn, { clock: () => `2026-07-01T00:00:${String(++tick).padStart(2, "0")}Z` });
  return { inst, raw, conn, runner };
}

async function setupPushPull() {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const c = await inst.connect();
  await c.run("LOAD ducknng");
  const one = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjects()[0] as Record<string, unknown>;
  const path = join(tmpdir(), `pi-bio-absurd-push-${process.pid}-${randomUUID()}.ipc`);
  const url = `ipc://${path}`;

  const pull = String((await one("SELECT (ducknng_open_socket('pull')).socket_id AS id")).id);
  const push = String((await one("SELECT (ducknng_open_socket('push')).socket_id AS id")).id);
  assert.equal((await one(`SELECT (ducknng_listen_socket(${pull}::UBIGINT, '${url}', 134217728, 0::UBIGINT)).ok AS ok`)).ok, true);
  assert.equal((await one(`SELECT (ducknng_dial_socket(${push}::UBIGINT, '${url}', 1000, 0::UBIGINT)).ok AS ok`)).ok, true);
  await new Promise((r) => setTimeout(r, 150));

  return {
    async armRecv(): Promise<bigint> {
      return (await one(`SELECT ducknng_recv_socket_raw_aio(${pull}::UBIGINT, 2000) AS a`)).a as bigint;
    },
    async sendJson(value: unknown): Promise<void> {
      const sent = await one(`SELECT (ducknng_send_socket_raw(${push}::UBIGINT, from_hex('${hex(JSON.stringify(value))}'), 1000)).ok AS ok`);
      assert.equal(sent.ok, true, "push wakeup sent");
    },
    async collectJson(aio: bigint): Promise<unknown> {
      const row = await one(`SELECT ok, hex(frame) AS frame FROM ducknng_aio_collect(list_value(${String(aio)}::UBIGINT), 2000)`);
      assert.equal(row.ok, true, "pull wakeup received");
      return JSON.parse(unhex(String(row.frame)));
    },
    async close(): Promise<void> {
      try { await c.run(`SELECT ducknng_close_socket(${push}::UBIGINT)`); } catch { /* best effort */ }
      try { await c.run(`SELECT ducknng_close_socket(${pull}::UBIGINT)`); } catch { /* best effort */ }
      c.closeSync();
      inst.closeSync();
      await rm(path, { force: true });
    },
  };
}

describe("Absurd-style durable queue + ducknng push pattern", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  test("a transport push references a durable wakeup event, then the worker claims from the queue", async () => {
    const queue = await setupQueue();
    const nng = await setupPushPull();
    const workerId = "worker:push";
    const runId = "absurd-push-1";

    try {
      const ghostRecv = await nng.armRecv();
      await nng.sendJson({ schema: "pi-bio.queue_wakeup.v1", id: "wake-ghost", runId: "ghost", reason: "enqueue" });
      assert.deepEqual(await nng.collectJson(ghostRecv), { schema: "pi-bio.queue_wakeup.v1", id: "wake-ghost", runId: "ghost", reason: "enqueue" });
      assert.equal(await observationAsOfKey(queue.conn, "job:ghost:wakeup:wake-ghost", FUTURE), null, "an unrecorded transport wakeup has no durable event");
      assert.equal(await claimJob(queue.conn, { workerId, now: "2026-07-01T00:00:05Z", leaseSeconds: 60 }), null, "an unrecorded transport wakeup does not create queue work in this backend");

      await queue.runner.submit({ runId, replay: replay(runId) });
      await recordObservation(queue.conn, {
        statementKey: `job:${runId}:wakeup:wake-real`,
        subjectId: `job:${runId}`,
        predicate: "job_wakeup",
        value: { schema: "pi-bio.job_wakeup.v1", id: "wake-real", runId, reason: "enqueue", transport: "ducknng.push_pull" },
        recordedAt: "2026-07-01T00:00:06Z",
        source: "coordinator",
      });
      const realRecv = await nng.armRecv();
      await nng.sendJson({ schema: "pi-bio.queue_wakeup.v1", id: "wake-real", runId, reason: "enqueue" });
      const wake = await nng.collectJson(realRecv) as { schema?: string; id?: string; runId?: string };
      assert.equal(wake.schema, "pi-bio.queue_wakeup.v1");
      assert.equal(wake.runId, runId);
      const durableWake = await observationAsOfKey(queue.conn, `job:${runId}:wakeup:${wake.id}`, FUTURE);
      assert.deepEqual(JSON.parse(durableWake!.value_json!), { schema: "pi-bio.job_wakeup.v1", id: "wake-real", runId, reason: "enqueue", transport: "ducknng.push_pull" });

      const claim = await claimJob(queue.conn, { workerId, now: "2026-07-01T00:00:10Z", leaseSeconds: 60 });
      assert.equal(claim?.runId, runId, "the worker starts only after claiming the durable queue row");
      assert.equal(claim?.attempt, 1);

      const checkpointKey = `job:${runId}:checkpoint:${claim!.attempt}`;
      await recordObservation(queue.conn, {
        statementKey: checkpointKey,
        subjectId: `job:${runId}`,
        predicate: "job_checkpoint",
        value: { schema: "pi-bio.job_checkpoint.v1", attempt: claim!.attempt, wakeupId: wake.id, event: "claimed" },
        recordedAt: "2026-07-01T00:00:11Z",
        source: workerId,
        digest: claim!.replayDigest,
      });
      await recordJobClaimStatus(queue.conn, {
        runId,
        workerId,
        attempt: claim!.attempt,
        replayDigest: claim!.replayDigest,
        phase: "running",
        progress: { current: 1, total: 2, unit: "steps" },
        message: "claimed after push wakeup",
        recordedAt: "2026-07-01T00:00:11Z",
      });
      await recordJobClaimResult(queue.conn, {
        runId,
        workerId,
        attempt: claim!.attempt,
        replayDigest: claim!.replayDigest,
        result: { rows: [{ answer: 1 }], checkpointKey },
        artifacts: [{ name: "answer.json", digest: `sha256:${"b".repeat(64)}`, kind: "application/json" }],
        recordedAt: "2026-07-01T00:00:12Z",
      });
      await recordJobClaimStatus(queue.conn, {
        runId,
        workerId,
        attempt: claim!.attempt,
        replayDigest: claim!.replayDigest,
        phase: "succeeded",
        progress: { current: 2, total: 2, unit: "steps" },
        recordedAt: "2026-07-01T00:00:13Z",
      });
      await finishJobClaim(queue.conn, { runId, workerId, now: "2026-07-01T00:00:14Z", phase: "succeeded" });

      assert.equal((await readJobQueueRecord(queue.conn, runId))?.phase, "succeeded");
      const status = await queue.runner.status(runId);
      assert.equal(status?.phase, "succeeded");
      assert.deepEqual(status?.progress, { current: 2, total: 2, unit: "steps" });
      assert.deepEqual((await queue.runner.collect(runId))?.result, { rows: [{ answer: 1 }], checkpointKey });

      const checkpoint = await observationAsOfKey(queue.conn, checkpointKey, FUTURE);
      assert.ok(checkpoint?.value_json);
      assert.deepEqual(JSON.parse(checkpoint.value_json), { schema: "pi-bio.job_checkpoint.v1", attempt: 1, wakeupId: "wake-real", event: "claimed" });
    } finally {
      await nng.close();
      queue.raw.closeSync();
      queue.inst.closeSync();
    }
  });
});

describe("Absurd-style step checkpoint pattern", () => {
  test("a reclaimed attempt resumes from a recorded step checkpoint instead of redoing it", async () => {
    const queue = await setupQueue();
    const runId = "absurd-step-resume-1";
    const replaySpec = replay(runId);
    const step1Key = `job:${runId}:step:extract`;
    const step2Key = `job:${runId}:step:summarize`;
    let extractExecutions = 0;

    const extractStep = async (claim: { attempt: number; replayDigest: string }) => {
      const existing = await observationAsOfKey(queue.conn, step1Key, FUTURE);
      if (existing?.value_json) return JSON.parse(existing.value_json) as { schema: string; rows: number; attempt: number };
      extractExecutions += 1;
      const value = { schema: "pi-bio.task_step.v1", rows: 5, attempt: claim.attempt };
      await recordObservation(queue.conn, {
        statementKey: step1Key,
        subjectId: `job:${runId}`,
        predicate: "job_step_checkpoint",
        value,
        recordedAt: "2026-07-01T00:00:11Z",
        source: "worker:step-a",
        digest: claim.replayDigest,
      });
      return value;
    };

    try {
      await queue.runner.submit({ runId, replay: replaySpec });

      const first = await claimJob(queue.conn, { workerId: "worker:step-a", now: "2026-07-01T00:00:10Z", leaseSeconds: 5 });
      assert.equal(first?.attempt, 1);
      assert.deepEqual(await extractStep(first!), { schema: "pi-bio.task_step.v1", rows: 5, attempt: 1 });
      assert.equal(extractExecutions, 1);

      const second = await claimJob(queue.conn, { workerId: "worker:step-b", now: "2026-07-01T00:00:16Z", leaseSeconds: 60 });
      assert.equal(second?.attempt, 2, "the expired lease is reclaimed as a new attempt");
      const reused = await extractStep(second!);
      assert.deepEqual(reused, { schema: "pi-bio.task_step.v1", rows: 5, attempt: 1 }, "the step result came from the durable checkpoint");
      assert.equal(extractExecutions, 1, "step 1 did not run again after resume");

      const summary = { schema: "pi-bio.task_step.v1", mean: 3, fromCheckpoint: step1Key, attempt: second!.attempt };
      await recordObservation(queue.conn, {
        statementKey: step2Key,
        subjectId: `job:${runId}`,
        predicate: "job_step_checkpoint",
        value: summary,
        recordedAt: "2026-07-01T00:00:17Z",
        source: "worker:step-b",
        digest: second!.replayDigest,
      });
      await recordJobClaimResult(queue.conn, {
        runId,
        workerId: "worker:step-b",
        attempt: second!.attempt,
        replayDigest: second!.replayDigest,
        result: { steps: [step1Key, step2Key], mean: summary.mean },
        recordedAt: "2026-07-01T00:00:18Z",
      });
      await recordJobClaimStatus(queue.conn, {
        runId,
        workerId: "worker:step-b",
        attempt: second!.attempt,
        replayDigest: second!.replayDigest,
        phase: "succeeded",
        recordedAt: "2026-07-01T00:00:19Z",
      });
      await finishJobClaim(queue.conn, { runId, workerId: "worker:step-b", now: "2026-07-01T00:00:20Z", phase: "succeeded" });

      assert.equal((await queue.runner.status(runId))?.phase, "succeeded");
      assert.deepEqual((await queue.runner.collect(runId))?.result, { steps: [step1Key, step2Key], mean: 3 });
      assert.deepEqual(JSON.parse((await observationAsOfKey(queue.conn, step2Key, FUTURE))!.value_json!), summary);
    } finally {
      queue.raw.closeSync();
      queue.inst.closeSync();
    }
  });
});
