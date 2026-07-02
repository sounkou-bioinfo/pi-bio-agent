import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey, recordObservation } from "../src/duckdb/observations.js";
import { inMemoryJobRunner } from "../src/hosts/in-memory-job-runner.js";
import { ledgerJobRunner } from "../src/hosts/ledger-job-runner.js";
import { submitBioJob, pollBioJob, collectBioJob, collectAndRecordBioJob, readJobRecord, resumeBioJob, cancelBioJob } from "../src/hosts/job-store.js";
import type { JobRunner } from "../src/core/jobs.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

// L1 — the async job lane over the SAME temporal substrate as Phase 4: a `job:<runId>:status` observation slot,
// so "status as of t" is an as-of query. In-memory runner (the second impl); job-store is the durable ledger.
const replay = (runId: string): RunReplaySpec => ({ schema: "pi-bio.run_replay_spec.v1", runId, kind: "query", sql: "SELECT 1" });

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(conn);
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-jobs-"));
  // a strictly-increasing injected clock for deterministic transition timestamps
  let n = 0; const clock = () => `T${String(++n).padStart(3, "0")}`;
  return { conn, cwd, clock };
}

describe("L1: JobRunner + job-store over the job:<runId>:status temporal slot", () => {
  test("submit -> queued, settle -> succeeded; the as-of ledger and result reflect the transition", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => ({ result: { rows: [{ answer: 42 }] }, artifacts: [{ name: "out", digest: "sha256:abc" }] }) });

    const queued = await submitBioJob(conn, runner, { cwd, runId: "j1", replay: replay("j1"), now: "2026-07-01T00:00:01Z" });
    assert.equal(queued.phase, "queued");
    // persisted snapshot exists at queued
    assert.equal((await readJobRecord(cwd, "j1"))!.phase, "queued");
    // the ledger as of S1 says queued
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "2026-07-01T00:00:01Z"))!.value_json!), "queued");

    await runner.settle("j1"); // background work completes (fake)
    const done = await pollBioJob(conn, runner, { cwd, runId: "j1", now: "2026-07-01T00:00:09Z" });
    assert.equal(done.phase, "succeeded");

    // as-of BEFORE the poll still reads queued; AFTER reads succeeded (temporal, not overwritten)
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "2026-07-01T00:00:01Z"))!.value_json!), "queued", "history is preserved");
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "2026-07-01T00:00:09Z"))!.value_json!), "succeeded");
    assert.equal((await readJobRecord(cwd, "j1"))!.phase, "succeeded", "persisted snapshot advanced");

    const result = await collectBioJob(runner, "j1");
    assert.equal(result!.phase, "succeeded");
    assert.deepEqual(result!.result, { rows: [{ answer: 42 }] });
    assert.deepEqual(result!.artifacts, [{ name: "out", digest: "sha256:abc" }]);
  });

  test("a job that throws lands failed with the error, and collect surfaces it", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => { throw new Error("boom in the worker"); } });
    await submitBioJob(conn, runner, { cwd, runId: "j2", replay: replay("j2"), now: "2026-07-01T00:00:01Z" });
    await runner.settle("j2");
    const st = await pollBioJob(conn, runner, { cwd, runId: "j2", now: "2026-07-01T00:00:09Z" });
    assert.equal(st.phase, "failed");
    const res = await collectBioJob(runner, "j2");
    assert.equal(res!.phase, "failed");
    assert.match(res!.error!, /boom in the worker/);
  });

  test("submit fails closed without a RunReplaySpec (a job you cannot reproduce is not a job)", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await assert.rejects(
      () => submitBioJob(conn, runner, { cwd, runId: "j3", replay: undefined as unknown as RunReplaySpec, now: "2026-07-01T00:00:01Z" }),
      /a RunReplaySpec is required/,
    );
    // a replay whose runId does not match the job is also rejected (fail closed at the store boundary)
    await assert.rejects(
      () => submitBioJob(conn, runner, { cwd, runId: "j4", replay: replay("DIFFERENT"), now: "2026-07-01T00:00:01Z" }),
      /replay.runId .* must match/,
    );
    // a HOLLOW replay (valid schema/kind/runId but nothing to re-run) is rejected — a job you can't reproduce isn't one
    await assert.rejects(
      () => submitBioJob(conn, runner, { cwd, runId: "jh", replay: { schema: "pi-bio.run_replay_spec.v1", runId: "jh", kind: "query" } as unknown as RunReplaySpec, now: "2026-07-01T00:00:01Z" }),
      /operationId or non-empty sql/,
    );
    // and a backdated/equal-timestamp transition is rejected (the monotonic-ledger guard)
    const r2 = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await submitBioJob(conn, r2, { cwd, runId: "j5", replay: replay("j5"), now: "2026-07-01T00:00:05Z" });
    await r2.settle("j5");
    await assert.rejects(() => pollBioJob(conn, r2, { cwd, runId: "j5", now: "2026-07-01T00:00:05Z" }), /strictly after/);
  });
});

describe("L2/L3: durable resume (no runner) + cancellation", () => {
  test("resume rehydrates a job's status from the durable record + ledger, WITHOUT the runner", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => ({ result: { ok: true } }) });
    await submitBioJob(conn, runner, { cwd, runId: "r1", replay: replay("r1"), now: "2026-07-01T00:00:01Z" });
    await runner.settle("r1");
    await pollBioJob(conn, runner, { cwd, runId: "r1", now: "2026-07-01T00:00:09Z" });

    // resume takes NO runner — the durable substrate (record + observation ledger) is the source of truth
    const resumed = await resumeBioJob(conn, { cwd, runId: "r1" });
    assert.equal(resumed.phase, "succeeded", "the ledger holds the truth after the runner is gone");
    assert.match(resumed.replayDigest, /^sha256:/);
    assert.equal(resumed.submittedAt, "2026-07-01T00:00:01Z");
    await assert.rejects(() => resumeBioJob(conn, { cwd, runId: "ghost" }), /no durable record/);
  });

  test("cancel records the terminal cancelled phase; a mid-flight completion cannot overwrite it", async () => {
    const { conn, cwd, clock } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const runner = inMemoryJobRunner({ clock, execute: async () => { await gate; return { result: { ok: true } }; } });

    await submitBioJob(conn, runner, { cwd, runId: "c1", replay: replay("c1"), now: "2026-07-01T00:00:01Z" });
    // cancel while the work is still gated (running)
    const cancelled = await cancelBioJob(conn, { cwd, runId: "c1", now: "2026-07-01T00:00:03Z", runner });
    assert.equal(cancelled.phase, "cancelled");
    assert.equal((await resumeBioJob(conn, { cwd, runId: "c1" })).phase, "cancelled", "durable cancel is in the ledger");

    release(); await runner.settle("c1"); // the gated work now completes — must NOT overwrite the cancel
    assert.equal((await runner.status("c1"))!.phase, "cancelled", "a cancelled job's completion is discarded");

    // already terminal -> cancel fails closed; unknown job -> fails closed
    await assert.rejects(() => cancelBioJob(conn, { cwd, runId: "c1", now: "2026-07-01T00:00:09Z", runner }), /already terminal/);
    await assert.rejects(() => cancelBioJob(conn, { cwd, runId: "ghost", now: "2026-07-01T00:00:09Z", runner }), /no durable record/);
  });

  test("a durable cancel (no runner) is FINAL — a later poll cannot resurrect it to the runner's succeeded", async () => {
    const { conn, cwd, clock } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const runner = inMemoryJobRunner({ clock, execute: async () => { await gate; return { result: { ok: true } }; } });
    await submitBioJob(conn, runner, { cwd, runId: "d1", replay: replay("d1"), now: "2026-07-01T00:00:01Z" });
    // durable cancel WITHOUT the runner — the runner keeps running and will report succeeded
    await cancelBioJob(conn, { cwd, runId: "d1", now: "2026-07-01T00:00:03Z" });
    release(); await runner.settle("d1");
    assert.equal((await runner.status("d1"))!.phase, "succeeded", "the runner itself completed to succeeded");
    // but the durable ledger is terminal (cancelled) -> poll must NOT append succeeded over it
    const st = await pollBioJob(conn, runner, { cwd, runId: "d1", now: "2026-07-01T00:00:09Z" });
    assert.equal(st.phase, "cancelled", "durably-terminal wins; poll never resurrects");
  });
});

describe("job durability: rich status is not lost + the ledger timestamp wins + results survive the runner", () => {
  test("poll persists the RICH {phase, message, progress} and returns the LEDGER time, not the runner clock", async () => {
    const { conn, cwd } = await setup();
    // a runner whose status carries progress+message (as a real long-running worker does), stamped with its OWN clock
    const runner: JobRunner = {
      async submit() {},
      async status(runId) { return { runId, phase: "running", at: "RUNNER-CLOCK", message: "step 2/3", progress: { current: 2, total: 3, unit: "chunks" } }; },
      async collect() { return null; },
    };
    await submitBioJob(conn, runner, { cwd, runId: "p1", replay: replay("p1"), now: "2026-07-01T00:00:01Z" });
    const st = await pollBioJob(conn, runner, { cwd, runId: "p1", now: "2026-07-01T00:00:05Z" });

    assert.equal(st.phase, "running");
    assert.equal(st.at, "2026-07-01T00:00:05Z", "#5: the returned timestamp is the LEDGER's (req.now), not RUNNER-CLOCK");
    assert.deepEqual(st.progress, { current: 2, total: 3, unit: "chunks" });
    // #4: the DURABLE ledger row carries the rich object, not a bare phase string — progress survives as-of
    const row = await observationAsOfKey(conn, "job:p1:status", "2026-07-01T00:00:05Z");
    assert.equal(row!.recorded_at, "2026-07-01T00:00:05Z");
    const v = JSON.parse(row!.value_json!);
    assert.deepEqual(v, { phase: "running", message: "step 2/3", progress: { current: 2, total: 3, unit: "chunks" } });

    // durable resume must NOT degrade a rich status to a bare phase — it surfaces the ledger's message/progress
    const resumed = await resumeBioJob(conn, { cwd, runId: "p1" });
    assert.equal(resumed.message, "step 2/3");
    assert.deepEqual(resumed.progress, { current: 2, total: 3, unit: "chunks" });
  });

  test("collectAndRecordBioJob makes an in-memory job's result durable: a FRESH ledgerJobRunner reads it back", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({ result: { rows: [{ answer: 42 }] }, artifacts: [{ name: "out", digest: "sha256:abc" }] }) });
    await submitBioJob(conn, local, { cwd, runId: "k1", replay: replay("k1"), now: "2026-07-01T00:00:01Z" });
    await local.settle("k1");
    await pollBioJob(conn, local, { cwd, runId: "k1", now: "2026-07-01T00:00:09Z" });
    const res = await collectAndRecordBioJob(conn, local, { cwd, runId: "k1", now: "2026-07-01T00:00:10Z" });
    assert.equal(res!.phase, "succeeded");

    // the in-memory runner is now "gone" — a fresh ledger-backed runner over the SAME store reads the durable result
    const ledger = ledgerJobRunner(conn, async () => {});
    const collected = await ledger.collect("k1");
    assert.equal(collected!.phase, "succeeded");
    assert.deepEqual(collected!.result, { rows: [{ answer: 42 }] }, "the result survived the runner via the ledger");
    assert.deepEqual(collected!.artifacts, [{ name: "out", digest: "sha256:abc" }], "artifacts too");
  });

  test("a FAILED in-memory job's error is durable: the fresh ledger runner surfaces it from the result slot", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => { throw new Error("boom in the worker"); } });
    await submitBioJob(conn, local, { cwd, runId: "k2", replay: replay("k2"), now: "2026-07-01T00:00:01Z" });
    await local.settle("k2");
    await pollBioJob(conn, local, { cwd, runId: "k2", now: "2026-07-01T00:00:09Z" });
    await collectAndRecordBioJob(conn, local, { cwd, runId: "k2", now: "2026-07-01T00:00:10Z" });

    const ledger = ledgerJobRunner(conn, async () => {});
    const collected = await ledger.collect("k2");
    assert.equal(collected!.phase, "failed");
    assert.match(collected!.error!, /boom in the worker/, "the error survived the runner (in-memory put it in collect, not status)");
  });

  test("collectAndRecordBioJob fails closed without a durable record", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await assert.rejects(() => collectAndRecordBioJob(conn, local, { cwd, runId: "ghost", now: "2026-07-01T00:00:10Z" }), /no durable record/);
  });

  test("progress within a phase is DURABLE: a same-phase progress change records a new as-of row", async () => {
    const { conn, cwd } = await setup();
    let progress = { current: 1, total: 3, unit: "chunks" };
    const runner: JobRunner = { async submit() {}, async status(runId) { return { runId, phase: "running", at: "RUNNER", progress }; }, async collect() { return null; } };
    await submitBioJob(conn, runner, { cwd, runId: "pg1", replay: replay("pg1"), now: "2026-07-01T00:00:01Z" });
    await pollBioJob(conn, runner, { cwd, runId: "pg1", now: "2026-07-01T00:00:05Z" }); // records running @ 1/3
    progress = { current: 2, total: 3, unit: "chunks" };
    await pollBioJob(conn, runner, { cwd, runId: "pg1", now: "2026-07-01T00:00:07Z" }); // SAME phase, new progress -> new row
    progress = { current: 2, total: 3, unit: "chunks" };
    const before = (await conn.all<{ n: bigint }>(`SELECT count(*) n FROM bio_observations WHERE statement_key='job:pg1:status'`))[0].n;
    await pollBioJob(conn, runner, { cwd, runId: "pg1", now: "2026-07-01T00:00:09Z" }); // UNCHANGED progress -> no new row
    const after = (await conn.all<{ n: bigint }>(`SELECT count(*) n FROM bio_observations WHERE statement_key='job:pg1:status'`))[0].n;
    assert.equal(Number(after), Number(before), "an unchanged poll does NOT record — bounded to real updates");

    // as-of the two poll times reflects the DIFFERENT progress values (durable history)
    assert.deepEqual(JSON.parse((await observationAsOfKey(conn, "job:pg1:status", "2026-07-01T00:00:05Z"))!.value_json!).progress, { current: 1, total: 3, unit: "chunks" });
    assert.deepEqual(JSON.parse((await observationAsOfKey(conn, "job:pg1:status", "2026-07-01T00:00:07Z"))!.value_json!).progress, { current: 2, total: 3, unit: "chunks" });
    assert.deepEqual((await resumeBioJob(conn, { cwd, runId: "pg1" })).progress, { current: 2, total: 3, unit: "chunks" }, "resume shows the latest durable progress");
  });

  test("collectAndRecordBioJob records the terminal STATUS too, so the result is reachable WITHOUT a prior poll", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({ result: { ok: 7 } }) });
    await submitBioJob(conn, local, { cwd, runId: "k3", replay: replay("k3"), now: "2026-07-01T00:00:01Z" });
    await local.settle("k3");
    // NO pollBioJob — the durable status is still 'queued'; collectAndRecord must advance it to terminal so a
    // fresh ledger runner (which gates on terminal status) can read the result.
    await collectAndRecordBioJob(conn, local, { cwd, runId: "k3", now: "2026-07-01T00:00:10Z" });
    const ledger = ledgerJobRunner(conn, async () => {});
    assert.equal((await ledger.status("k3"))!.phase, "succeeded", "status advanced to terminal by collectAndRecord");
    assert.deepEqual((await ledger.collect("k3"))!.result, { ok: 7 }, "result is reachable without a prior poll");
  });

  test("durably-terminal wins: collectAndRecordBioJob does NOT record a runner 'succeeded' over a durable cancel", async () => {
    const { conn, cwd, clock } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const local = inMemoryJobRunner({ clock, execute: async () => { await gate; return { result: { ok: true } }; } });
    await submitBioJob(conn, local, { cwd, runId: "x9", replay: replay("x9"), now: "2026-07-01T00:00:01Z" });
    await cancelBioJob(conn, { cwd, runId: "x9", now: "2026-07-01T00:00:03Z" }); // durable cancel (no runner)
    release(); await local.settle("x9"); // the runner itself completes to succeeded
    assert.equal((await local.status("x9"))!.phase, "succeeded", "runner completed");

    const res = await collectAndRecordBioJob(conn, local, { cwd, runId: "x9", now: "2026-07-01T00:00:10Z" });
    assert.equal(res!.phase, "cancelled", "the durable cancel wins — not the runner's succeeded");
    // and no success result leaked into the ledger's result slot
    const ledger = ledgerJobRunner(conn, async () => {});
    assert.equal((await ledger.collect("x9"))!.phase, "cancelled");
    assert.equal((await ledger.collect("x9"))!.result, undefined, "no success result recorded for a cancelled job");
  });

  test("fail closed: a runId with an existing LEDGER row (no local snapshot) is refused — no stale-state adoption", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => ({}) });
    // a PRIOR job left a ledger row for this runId, but the local snapshot is gone
    await recordObservation(conn, { statementKey: "job:reuse:status", subjectId: "job:reuse", predicate: "job_status", value: "succeeded", recordedAt: "2026-07-01T00:00:01Z", source: "prior" });
    await assert.rejects(() => submitBioJob(conn, runner, { cwd, runId: "reuse", replay: replay("reuse"), now: "2026-07-01T00:00:09Z" }), /already exists in the shared ledger/);
  });

  test("fail closed: an unsafe runId (path traversal) is rejected", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({}) });
    for (const bad of ["../evil", "a/b", ".hidden", "x y"]) {
      await assert.rejects(() => submitBioJob(conn, local, { cwd, runId: bad, replay: { schema: "pi-bio.run_replay_spec.v1", runId: bad, kind: "query", sql: "SELECT 1" }, now: "2026-07-01T00:00:01Z" }), /unsafe runId|runId/);
    }
  });

  test("fail closed: a corrupt job SNAPSHOT (bad phase) throws on read, not an invalid typed record", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await submitBioJob(conn, local, { cwd, runId: "z2", replay: replay("z2"), now: "2026-07-01T00:00:01Z" });
    // corrupt the persisted snapshot's phase (e.g. disk rot / hand-edit)
    const { promises: fsp } = await import("node:fs");
    const p = join(cwd, ".pi", "bio-agent", "jobs", "z2.json");
    const rec = JSON.parse(await fsp.readFile(p, "utf8"));
    await fsp.writeFile(p, JSON.stringify({ ...rec, phase: "banana" }));
    await assert.rejects(() => readJobRecord(cwd, "z2"), /malformed job record/);
  });

  test("fail closed: a corrupt status phase in the ledger throws, not a bogus typed phase", async () => {
    const { conn, cwd, clock } = await setup();
    const local = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await submitBioJob(conn, local, { cwd, runId: "z1", replay: replay("z1"), now: "2026-07-01T00:00:01Z" });
    // a hostile/corrupt shared-ledger row lands in the status slot
    await recordObservation(conn, { statementKey: "job:z1:status", subjectId: "job:z1", predicate: "job_status", value: "banana", recordedAt: "2026-07-01T00:00:05Z", source: "hostile" });
    await assert.rejects(() => resumeBioJob(conn, { cwd, runId: "z1" }), /invalid status phase/);
  });
});
