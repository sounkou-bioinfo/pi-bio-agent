import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";

import type { RunReplaySpec } from "../src/core/reproducibility.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import {
  cancelQueuedJob,
  claimJob,
  createJobQueueSchema,
  enqueueJob,
  readJobQueueRecord,
  recordJobClaimResult,
  recordJobClaimStatus,
} from "../src/hosts/job-queue.js";
import { createQueueJobWorker } from "../src/hosts/queue-job-worker.js";
import { createSqlConnHttpClient, createSqlConnHttpServer } from "../src/hosts/remote-sql-conn.js";
import type { SqlConn } from "../src/core/ports.js";

const FUTURE = "9999-12-31T23:59:59.999Z";
const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(conn);
  await createJobQueueSchema(conn);
  let n = 0;
  const clock = () => new Date(Date.now() + ++n).toISOString();
  return { conn, clock };
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for queue condition");
}

describe("queue-job-worker: production queue worker lifecycle", () => {
  test("runOne executes, records terminal running/result/status, and finishes the queue", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk1", replay: replay("jk1"), now: clock() });

    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-run",
      leaseSeconds: 20,
      heartbeatMs: 500,
      executor: async () => ({ result: { answer: 42 } }),
    });

    assert.equal(await worker.runOne(), true);

    const status = await observationAsOfKey(conn, "job:jk1:status", FUTURE);
    assert.equal(status?.value_json ? JSON.parse(status.value_json).phase ?? JSON.parse(status.value_json) : undefined, "succeeded");
    const result = await observationAsOfKey(conn, "job:jk1:result", FUTURE);
    const parsed = JSON.parse(result!.value_json!);
    assert.equal(parsed.schema, "pi-bio.job_result.v1");
    assert.deepEqual(parsed.result, { answer: 42 });
    assert.equal((await readJobQueueRecord(conn, "jk1"))?.phase, "succeeded");
  });

  test("fast completion does not wait for heartbeatMs before finishing", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk-fast", replay: replay("jk-fast"), now: clock() });

    const heartbeatMs = 2000;
    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-fast",
      leaseSeconds: 20,
      heartbeatMs,
      executor: async () => ({ result: { ok: true } }),
    });

    const start = Date.now();
    await worker.runOne();
    const elapsed = Date.now() - start;
    assert.equal(elapsed < heartbeatMs, true);
    assert.equal(elapsed < heartbeatMs / 2, true);

    assert.equal((await readJobQueueRecord(conn, "jk-fast"))?.phase, "succeeded");
    const fastResult = await observationAsOfKey(conn, "job:jk-fast:result", FUTURE);
    if (!fastResult || fastResult.value_json == null) throw new Error("missing job result");
    assert.equal(fastResult.value_json.includes("ok"), true);
  });

  test("runLoop passes abort signal to active job and aborts it during host shutdown", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk-loop", replay: replay("jk-loop"), now: clock() });

    let aborted = false;
    const executorStarted = deferred<void>();
    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-loop",
      leaseSeconds: 20,
      heartbeatMs: 1000,
      executor: async (_replay, signal) => {
        executorStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return {};
      },
    });

    const stop = new AbortController();
    const loop = worker.runLoop({ signal: stop.signal, idleMs: 2000 });

    await executorStarted.promise;

    const start = Date.now();
    stop.abort();
    await loop;

    const elapsed = Date.now() - start;
    assert.equal(aborted, true);
    assert.equal(elapsed < 2000, true);
    const rec = await readJobQueueRecord(conn, "jk-loop");
    assert.equal(rec?.phase, "running");
    assert.equal(rec?.claimedBy, "w-loop");
    assert.equal(await observationAsOfKey(conn, "job:jk-loop:result", FUTURE), null);
  });

  test("abort during initial running-status write skips executor start", async (t) => {
    const db = await DuckDBInstance.create(":memory:");
    const raw = await db.connect();
    t.after(() => {
      raw.closeSync();
      db.closeSync();
    });
    const baseConn = duckdbNodeConn(raw);
    await createBioObservationSchema(baseConn);
    await createJobQueueSchema(baseConn);

    let n = 0;
    const clock = () => new Date(Date.now() + ++n).toISOString();
    await enqueueJob(baseConn, { runId: "jk-early-stop", replay: replay("jk-early-stop"), now: clock() });

    const runningWriteStarted = deferred<void>();
    const resumeRunningWrite = deferred<void>();
    let blocked = false;

    const conn: SqlConn = {
      async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        const isStatusWrite =
          !blocked && sql.includes("INSERT INTO bio_observations") && params[1] === "job:jk-early-stop:status";
        if (isStatusWrite) {
          blocked = true;
          runningWriteStarted.resolve();
          await resumeRunningWrite.promise;
        }
        return baseConn.all(sql, params);
      },
      async run(sql: string, params: readonly unknown[] = []): Promise<void> {
        return baseConn.run(sql, params);
      },
    };

    let executorRan = false;
    const stop = new AbortController();
    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-early-stop",
      leaseSeconds: 20,
      heartbeatMs: 1000,
      executor: async () => {
        executorRan = true;
        return {};
      },
    });

    const run = worker.runOne(stop.signal);
    await runningWriteStarted.promise;

    stop.abort();
    resumeRunningWrite.resolve();
    assert.equal(await run, true);

    assert.equal(executorRan, false);
    const status = await observationAsOfKey(conn, "job:jk-early-stop:status", FUTURE);
    assert.ok(status);
    const statusParsed = JSON.parse(status.value_json!);
    assert.equal((statusParsed.phase ?? statusParsed), "running");
    assert.equal(await observationAsOfKey(conn, "job:jk-early-stop:result", FUTURE), null);

  });

  test("generic error messages are recorded by default and formatters are optional, capped, and fail-safe", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk-err-default", replay: replay("jk-err-default"), now: clock() });

    const defaultWorker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-err-default",
      leaseSeconds: 20,
      heartbeatMs: 500,
      executor: async () => {
        throw new Error("secret credentials: abc123");
      },
    });
    await defaultWorker.runOne();
    const defaultResult = await observationAsOfKey(conn, "job:jk-err-default:result", FUTURE);
    if (!defaultResult || defaultResult.value_json == null) throw new Error("missing job result");
    const defaultParsed = JSON.parse(defaultResult.value_json);
    assert.equal(defaultParsed.error, "job execution failed");
    assert.equal(defaultParsed.error.includes("abc123"), false);

    await enqueueJob(conn, { runId: "jk-err-formatted", replay: replay("jk-err-formatted"), now: clock() });
    const cappedMessage = "x".repeat(4000);
    const formattedWorker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-err-formatted",
      leaseSeconds: 20,
      heartbeatMs: 500,
      errorFormatter: () => cappedMessage,
      executor: async () => {
        throw new Error("format-target error");
      },
    });
    await formattedWorker.runOne();
    const formattedResult = await observationAsOfKey(conn, "job:jk-err-formatted:result", FUTURE);
    if (!formattedResult || formattedResult.value_json == null) throw new Error("missing job result");
    const formattedParsed = JSON.parse(formattedResult.value_json);
    assert.equal(formattedParsed.error.length > 0, true);
    assert.equal(Buffer.byteLength(formattedParsed.error, "utf8") <= 2048, true);

    await enqueueJob(conn, { runId: "jk-err-badfmt", replay: replay("jk-err-badfmt"), now: clock() });
    const badFormatterWorker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-err-badfmt",
      leaseSeconds: 20,
      heartbeatMs: 500,
      errorFormatter: () => 42 as unknown as string,
      executor: async () => {
        throw new Error("bad formatter target");
      },
    });
    await badFormatterWorker.runOne();
    const badFmtResult = await observationAsOfKey(conn, "job:jk-err-badfmt:result", FUTURE);
    if (!badFmtResult || badFmtResult.value_json == null) throw new Error("missing job result");
    const badParsed = JSON.parse(badFmtResult.value_json);
    assert.equal(badParsed.error, "job execution failed");
  });

  test("queue cancellation/ownership loss aborts the executor and skips durable writes", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk2", replay: replay("jk2"), now: clock() });

    let aborted = false;
    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "w-cancel",
      leaseSeconds: 5,
      heartbeatMs: 250,
      executor: async (_, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return { result: { ok: true } };
      },
    });

    const running = worker.runOne();
    await waitUntil(async () => (await readJobQueueRecord(conn, "jk2"))?.phase === "running");
    await cancelQueuedJob(conn, { runId: "jk2", now: clock() });

    assert.equal(await running, true);
    assert.equal(aborted, true);
    assert.equal((await readJobQueueRecord(conn, "jk2"))?.phase, "cancelled");
    assert.equal(await observationAsOfKey(conn, "job:jk2:result", FUTURE), null);
  });

  test("stale lease reclaims allow a later attempt while stale writers never win", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk3", replay: replay("jk3"), now: clock() });

    let staleAborted = false;
    let freshRan = false;

    const stale = createQueueJobWorker(conn, {
      clock,
      workerId: "w-old",
      leaseSeconds: 2,
      heartbeatMs: 1500,
      executor: async (_, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            staleAborted = true;
            resolve();
          }, { once: true });
        });
        return { result: { worker: "old" } };
      },
    });

    const fresh = createQueueJobWorker(conn, {
      clock,
      workerId: "w-new",
      leaseSeconds: 2,
      heartbeatMs: 1500,
      executor: async () => {
        freshRan = true;
        return { result: { worker: "new" } };
      },
    });

    const staleRun = stale.runOne();
    await waitUntil(async () => {
      const rec = await readJobQueueRecord(conn, "jk3");
      return rec?.phase === "running" && rec?.claimedBy === "w-old";
    });

    await conn.run("UPDATE pi_bio_job_queue SET claim_expires_at = ? WHERE run_id = ?", [new Date(Date.now() - 60_000).toISOString(), "jk3"]);
    const freshRun = fresh.runOne();

    assert.equal(await Promise.all([staleRun, freshRun]).then((rows) => rows[1]), true);
    assert.equal(staleAborted, true);
    assert.equal(freshRan, true);

    const result = JSON.parse((await observationAsOfKey(conn, "job:jk3:result", FUTURE))!.value_json!);
    assert.deepEqual(result.result, { worker: "new" });
    assert.equal((await readJobQueueRecord(conn, "jk3"))?.attempt, 2);
  });

  test("terminal-result recovery does not rerun when digest matches and claim is reclaimed", async () => {
    const { conn, clock } = await setup();
    await enqueueJob(conn, { runId: "jk4", replay: replay("jk4"), now: clock() });

    const initial = await claimJob(conn, { workerId: "seed", now: clock(), leaseSeconds: 30 });
    assert(initial);
    await recordJobClaimStatus(conn, {
      runId: "jk4",
      workerId: "seed",
      attempt: initial.attempt,
      replayDigest: initial.replayDigest,
      phase: "succeeded",
      recordedAt: clock(),
      source: "seed",
    });
    await recordJobClaimResult(conn, {
      runId: "jk4",
      workerId: "seed",
      attempt: initial.attempt,
      replayDigest: initial.replayDigest,
      recordedAt: clock(),
      result: { replayed: true },
    });
    await conn.run("UPDATE pi_bio_job_queue SET claim_expires_at = ? WHERE run_id = ?", [new Date(Date.now() - 60_000).toISOString(), "jk4"]);

    let rerun = false;
    const worker = createQueueJobWorker(conn, {
      clock,
      workerId: "restorer",
      leaseSeconds: 5,
      heartbeatMs: 250,
      executor: async () => {
        rerun = true;
        return { result: { worker: "restorer" } };
      },
    });

    assert.equal(await worker.runOne(), true);
    assert.equal(rerun, false);

    const result = JSON.parse((await observationAsOfKey(conn, "job:jk4:result", FUTURE))!.value_json!);
    assert.deepEqual(result.result, { replayed: true });
    assert.equal((await readJobQueueRecord(conn, "jk4"))?.phase, "succeeded");
  });

  test("remote SQL client/server processes queue claims and serializes DB calls", async () => {
    const db = await DuckDBInstance.create(":memory:");
    const raw = await db.connect();
    const base = duckdbNodeConn(raw);
    await createBioObservationSchema(base);
    await createJobQueueSchema(base);

    let active = 0;
    let peak = 0;
    const sleepMs = 25;
    const instrumented: SqlConn = {
      async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await sleep(sleepMs);
          return base.all<T>(sql, params);
        } finally {
          active -= 1;
        }
      },
      async run(sql: string, params: readonly unknown[] = []): Promise<void> {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await sleep(sleepMs);
          await base.run(sql, params);
        } finally {
          active -= 1;
        }
      },
    };

    const server = await createSqlConnHttpServer({ conn: instrumented, bearerToken: "token" });
    const client = createSqlConnHttpClient({ endpoint: server.url, bearerToken: "token" });

    try {
      await createBioObservationSchema(client);
      await createJobQueueSchema(client);
      let n = 0;
      const clock = () => new Date(Date.now() + ++n).toISOString();

      await enqueueJob(client, { runId: "r1", replay: replay("r1"), now: clock() });
      await enqueueJob(client, { runId: "r2", replay: replay("r2"), now: clock() });

      const w1 = createQueueJobWorker(client, {
        clock,
        workerId: "rw-1",
        leaseSeconds: 20,
        heartbeatMs: 1000,
        executor: async (r) => ({ result: { by: "rw-1", runId: r.runId } }),
      });
      const w2 = createQueueJobWorker(client, {
        clock,
        workerId: "rw-2",
        leaseSeconds: 20,
        heartbeatMs: 1000,
        executor: async (r) => ({ result: { by: "rw-2", runId: r.runId } }),
      });

      const [rw1Done, rw2Done] = await Promise.all([w1.runOne(), w2.runOne()]);
      assert.equal(rw1Done, true);
      assert.equal(rw2Done, true);
      assert.equal(await observationAsOfKey(client, "job:r1:status", FUTURE) !== null, true);
      assert.equal(await observationAsOfKey(client, "job:r2:status", FUTURE) !== null, true);
      assert.equal(peak, 1);
    } finally {
      await server.close();
      raw.closeSync();
      db.closeSync();
    }
  });
});
