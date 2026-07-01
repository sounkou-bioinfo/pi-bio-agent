import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { inMemoryJobRunner } from "../src/hosts/in-memory-job-runner.js";
import { submitBioJob, pollBioJob, collectBioJob, readJobRecord } from "../src/hosts/job-store.js";
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

    const queued = await submitBioJob(conn, runner, { cwd, runId: "j1", replay: replay("j1"), now: "S1" });
    assert.equal(queued.phase, "queued");
    // persisted snapshot exists at queued
    assert.equal((await readJobRecord(cwd, "j1"))!.phase, "queued");
    // the ledger as of S1 says queued
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "S1"))!.value_json!), "queued");

    await runner.settle("j1"); // background work completes (fake)
    const done = await pollBioJob(conn, runner, { cwd, runId: "j1", now: "S9" });
    assert.equal(done.phase, "succeeded");

    // as-of BEFORE the poll still reads queued; AFTER reads succeeded (temporal, not overwritten)
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "S1"))!.value_json!), "queued", "history is preserved");
    assert.equal(JSON.parse((await observationAsOfKey(conn, "job:j1:status", "S9"))!.value_json!), "succeeded");
    assert.equal((await readJobRecord(cwd, "j1"))!.phase, "succeeded", "persisted snapshot advanced");

    const result = await collectBioJob(runner, "j1");
    assert.equal(result!.phase, "succeeded");
    assert.deepEqual(result!.result, { rows: [{ answer: 42 }] });
    assert.deepEqual(result!.artifacts, [{ name: "out", digest: "sha256:abc" }]);
  });

  test("a job that throws lands failed with the error, and collect surfaces it", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => { throw new Error("boom in the worker"); } });
    await submitBioJob(conn, runner, { cwd, runId: "j2", replay: replay("j2"), now: "S1" });
    await runner.settle("j2");
    const st = await pollBioJob(conn, runner, { cwd, runId: "j2", now: "S9" });
    assert.equal(st.phase, "failed");
    const res = await collectBioJob(runner, "j2");
    assert.equal(res!.phase, "failed");
    assert.match(res!.error!, /boom in the worker/);
  });

  test("submit fails closed without a RunReplaySpec (a job you cannot reproduce is not a job)", async () => {
    const { conn, cwd, clock } = await setup();
    const runner = inMemoryJobRunner({ clock, execute: async () => ({}) });
    await assert.rejects(
      () => submitBioJob(conn, runner, { cwd, runId: "j3", replay: undefined as unknown as RunReplaySpec, now: "S1" }),
      /must carry a RunReplaySpec/,
    );
  });
});
