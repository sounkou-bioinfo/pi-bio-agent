import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import {
  cancelQueuedJob,
  claimJob,
  createJobQueueSchema,
  enqueueJob,
  finishJobClaim,
  heartbeatJobClaim,
  parkJobClaim,
  readJobQueueRecord,
  recordJobClaimResult,
  recordJobClaimStatus,
} from "../src/hosts/job-queue.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(conn);
  await createJobQueueSchema(conn);
  return conn;
}

describe("job queue: durable worker coordination", () => {
  test("enqueue validates replay specs and refuses duplicate runIds", async () => {
    const conn = await setup();
    const rec = await enqueueJob(conn, { runId: "q1", replay: replay("q1"), now: "2026-07-01T00:00:00Z" });
    assert.equal(rec.phase, "queued");
    assert.equal(rec.attempt, 0);
    assert.match(rec.replayDigest, /^sha256:/);

    await assert.rejects(
      () => enqueueJob(conn, { runId: "q2", replay: replay("OTHER"), now: "2026-07-01T00:00:00Z" }),
      /replay.runId .* must match/,
    );
    await assert.rejects(
      () => enqueueJob(conn, { runId: "q1", replay: replay("q1"), now: "2026-07-01T00:00:01Z" }),
      /duplicate key|constraint|PRIMARY KEY/i,
    );
  });

  test("claim returns one available replay and hides it until the lease expires", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "a", replay: replay("a"), now: "2026-07-01T00:00:00Z" });
    await enqueueJob(conn, { runId: "b", replay: replay("b"), now: "2026-07-01T00:00:00Z" });

    const a = await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:00:01Z", leaseSeconds: 60 });
    assert.equal(a?.runId, "a");
    assert.equal(a?.phase, "running");
    assert.equal(a?.claimedBy, "w1");
    assert.equal(a?.attempt, 1);
    assert.deepEqual(a?.replay, replay("a"));

    const b = await claimJob(conn, { workerId: "w2", now: "2026-07-01T00:00:02Z", leaseSeconds: 60 });
    assert.equal(b?.runId, "b", "the first live claim is hidden; the next job is claimed");

    const none = await claimJob(conn, { workerId: "w3", now: "2026-07-01T00:00:03Z", leaseSeconds: 60 });
    assert.equal(none, null);

    const reclaimed = await claimJob(conn, { workerId: "w3", now: "2026-07-01T00:01:03Z", leaseSeconds: 60 });
    assert.equal(reclaimed?.runId, "a");
    assert.equal(reclaimed?.claimedBy, "w3");
    assert.equal(reclaimed?.attempt, 2, "expired leases are new attempts");
  });

  test("heartbeat and finish require the current live owner", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "h1", replay: replay("h1"), now: "2026-07-01T00:00:00Z" });
    await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:00:01Z", leaseSeconds: 30 });

    await assert.rejects(
      () => heartbeatJobClaim(conn, { runId: "h1", workerId: "w2", now: "2026-07-01T00:00:02Z", leaseSeconds: 30 }),
      /not held by worker 'w2'/,
    );

    const hb = await heartbeatJobClaim(conn, { runId: "h1", workerId: "w1", now: "2026-07-01T00:00:20Z", leaseSeconds: 60 });
    assert.equal(hb.phase, "running");
    assert.equal(hb.claimedBy, "w1");
    assert.equal(hb.attempt, 1);

    await assert.rejects(
      () => finishJobClaim(conn, { runId: "h1", workerId: "w2", now: "2026-07-01T00:00:21Z", phase: "succeeded" }),
      /not held by worker 'w2'/,
    );

    const done = await finishJobClaim(conn, { runId: "h1", workerId: "w1", now: "2026-07-01T00:00:40Z", phase: "succeeded" });
    assert.equal(done.phase, "succeeded");
    assert.equal(done.claimedBy, undefined);
    assert.equal(await claimJob(conn, { workerId: "w3", now: "2026-07-01T00:10:00Z", leaseSeconds: 30 }), null, "terminal jobs are never reclaimed");
  });

  test("a stale owner cannot heartbeat or finish after a lease is reclaimed", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "stale", replay: replay("stale"), now: "2026-07-01T00:00:00Z" });
    await claimJob(conn, { workerId: "old", now: "2026-07-01T00:00:01Z", leaseSeconds: 10 });
    const fresh = await claimJob(conn, { workerId: "new", now: "2026-07-01T00:00:12Z", leaseSeconds: 30 });
    assert.equal(fresh?.claimedBy, "new");

    await assert.rejects(
      () => heartbeatJobClaim(conn, { runId: "stale", workerId: "old", now: "2026-07-01T00:00:13Z", leaseSeconds: 30 }),
      /not held by worker 'old'/,
    );
    await assert.rejects(
      () => finishJobClaim(conn, { runId: "stale", workerId: "old", now: "2026-07-01T00:00:13Z", phase: "failed" }),
      /not held by worker 'old'/,
    );
  });

  test("claim-gated status/result reject stale writes after reclaim or cancel", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "gate", replay: replay("gate"), now: "2026-07-01T00:00:00Z" });
    const first = await claimJob(conn, { workerId: "old", now: "2026-07-01T00:00:01Z", leaseSeconds: 10 });
    assert.equal(first?.attempt, 1);

    await recordJobClaimStatus(conn, {
      runId: "gate",
      workerId: "old",
      attempt: first!.attempt,
      replayDigest: first!.replayDigest,
      phase: "running",
      recordedAt: "2026-07-01T00:00:02Z",
      message: "attempt 1 is live",
    });
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:gate:status", "2026-07-01T00:00:03Z"))!.value_json!).phase, "running");

    const second = await claimJob(conn, { workerId: "new", now: "2026-07-01T00:00:12Z", leaseSeconds: 30 });
    assert.equal(second?.attempt, 2);
    await assert.rejects(
      () => recordJobClaimResult(conn, {
        runId: "gate",
        workerId: "old",
        attempt: first!.attempt,
        replayDigest: first!.replayDigest,
        recordedAt: "2026-07-01T00:00:13Z",
        result: { stale: true },
      }),
      /not held by worker 'old'/,
    );

    await recordJobClaimResult(conn, {
      runId: "gate",
      workerId: "new",
      attempt: second!.attempt,
      replayDigest: second!.replayDigest,
      recordedAt: "2026-07-01T00:00:14Z",
      result: { ok: true },
    });
    assert.deepEqual(JSON.parse((await observationAsOfKey(conn, "job:gate:result", "2026-07-01T00:00:15Z"))!.value_json!).result, { ok: true });

    await cancelQueuedJob(conn, { runId: "gate", now: "2026-07-01T00:00:16Z" });
    await assert.rejects(
      () => recordJobClaimStatus(conn, {
        runId: "gate",
        workerId: "new",
        attempt: second!.attempt,
        replayDigest: second!.replayDigest,
        phase: "succeeded",
        recordedAt: "2026-07-01T00:00:17Z",
      }),
      /not held by worker 'new'/,
    );
  });

  test("park moves a live claim to waiting until its availability time", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "wait", replay: replay("wait"), now: "2026-07-01T00:00:00Z" });
    await claimJob(conn, { workerId: "w1", now: "2026-07-01T00:00:01Z", leaseSeconds: 60 });
    const parked = await parkJobClaim(conn, {
      runId: "wait",
      workerId: "w1",
      now: "2026-07-01T00:00:02Z",
      availableAt: "2026-07-01T00:10:00Z",
    });
    assert.equal(parked.phase, "waiting");
    assert.equal(parked.claimedBy, undefined);

    assert.equal(await claimJob(conn, { workerId: "early", now: "2026-07-01T00:09:59Z", leaseSeconds: 30 }), null);
    const later = await claimJob(conn, { workerId: "later", now: "2026-07-01T00:10:00Z", leaseSeconds: 30 });
    assert.equal(later?.runId, "wait");
    assert.equal(later?.attempt, 2);
  });

  test("read fails closed on corrupt replay rows", async () => {
    const conn = await setup();
    await enqueueJob(conn, { runId: "bad", replay: replay("bad"), now: "2026-07-01T00:00:00Z" });
    await conn.run(`UPDATE pi_bio_job_queue SET replay_json = '{"schema":"pi-bio.run_replay_spec.v1","runId":"OTHER","kind":"query","sql":"SELECT 1"}' WHERE run_id = 'bad'`);
    await assert.rejects(() => readJobQueueRecord(conn, "bad"), /replay.runId .* must match/);
  });
});
