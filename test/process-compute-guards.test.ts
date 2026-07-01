import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";

// Param-guard tests for the process.compute resolver — these validate BEFORE any spawn or extension LOAD, so
// they need neither R nor nanoarrow and run deterministically everywhere. They lock in the hardening from the
// pal review: a non-positive timeoutMs must NOT silently disable the timeout, and params.env must be strings.

const BASE = {
  schema: "pi-bio.manifest.v1", id: "compute-guards", version: "0.1.0",
  title: "process.compute param guards", description: "fail-closed param validation for process.compute",
  provides: {
    resolvers: [{ id: "process.compute", version: "0.1.0", title: "compute", description: "compute", output: { mode: "table" } }],
  },
};

async function runWith(params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-guards-"));
  const manifest = { ...BASE, provides: { ...BASE.provides, resources: [{ id: "r", title: "r", kind: "virtual", resolver: "process.compute", params }] } };
  await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest));
  const out = await runBioQueryFromManifest({
    cwd, dbPath: ":memory:", manifestPath: "manifest.json",
    sql: "SELECT * FROM r",
    process: { runner: nodeProcessRunner() }, // runner bound — but validation throws before it ever spawns
    runId: "g1", now: "T1",
  });
  return out.ok ? { ok: true } : { ok: false, error: (out as { error?: unknown }).error != null ? String((out as { error: unknown }).error) : "" };
}

describe("process.compute: fail-closed param guards (no spawn, no R)", () => {
  const good = { table: "r", inputSql: "SELECT 1 AS x", command: ["true"] };

  test("timeoutMs: 0 is rejected (must not silently disable the timeout -> unbounded child)", async () => {
    const out = await runWith({ ...good, timeoutMs: 0 });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /timeoutMs must be a positive number/);
  });

  test("a negative timeoutMs is rejected", async () => {
    const out = await runWith({ ...good, timeoutMs: -5 });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /timeoutMs must be a positive number/);
  });

  test("params.env with a non-string value is rejected (fail closed, not coerced into child env)", async () => {
    const out = await runWith({ ...good, env: { OMP_NUM_THREADS: 4 } });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /params\.env\.OMP_NUM_THREADS must be a string/);
  });
});
