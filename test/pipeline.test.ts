import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runPipeline } from "../src/core/pipeline.js";

// push/pull pipeline: a pool of N workers pull from a shared queue (load-balanced). Results come back in INPUT
// order regardless of completion order, and at most N run at once. This is the map step of the RLM labeling
// map-reduce as a self-balancing worker pool.

describe("pipeline: push/pull worker pool", () => {
  test("processes all tasks, results in input order, never exceeding the concurrency limit", async () => {
    const tasks = [10, 40, 20, 50, 30, 5, 60, 15]; // "labeling work" of varying durations
    let active = 0, maxActive = 0;
    const worker = async (ms: number, i: number): Promise<string> => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return `task#${i}=${ms}`;
    };
    const results = await runPipeline(tasks, worker, 3);

    assert.deepEqual(results, tasks.map((ms, i) => `task#${i}=${ms}`)); // input order preserved
    assert.ok(maxActive <= 3, `at most 3 ran concurrently (saw ${maxActive})`);
    assert.ok(maxActive >= 2, "the pool actually parallelized");
  });

  test("concurrency is clamped to the task count; empty input is a no-op", async () => {
    assert.deepEqual(await runPipeline([], async () => 1, 4), []);
    assert.deepEqual(await runPipeline([7], async (x) => x * 2, 4), [14]);
  });
});
