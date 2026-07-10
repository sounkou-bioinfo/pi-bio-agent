import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { collectComputeTask } from "../src/core/ports.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";

// Param-guard tests for the compute.run resolver — these validate BEFORE any spawn or extension LOAD, so
// they need neither R nor nanoarrow and run deterministically everywhere. They lock in the hardening from the
// pal review: a non-positive timeoutMs must NOT silently disable the timeout, and params.env must be strings.

describe("SECURITY: spawned children do not inherit host secrets, and CAS/run paths can't escape their root", () => {
  test("fail closed BEFORE effects: a run-dir-unsafe runId is rejected at the entry, not after the run at persist", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-runid-"));
    await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify({ schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} }));
    for (const bad of [".", "..", "-x", ".hidden"]) {
      await assert.rejects(() => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", sql: "SELECT 1", runId: bad }), /runId must start with|path traversal/);
    }
    // grammar AGREES with core/job-store: a ':'-namespaced id (accepted there) also persists/executes here
    const ok = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", sql: "SELECT 1", runId: "study:opentargets:001" });
    assert.equal(ok.ok, true, "a namespaced runId with ':' runs and persists through run-store");
  });


  test("compute command arg resolution only applies to ./ and ../ script argv, not shell -c command strings", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-cmdpath-"));
    const scriptsDir = join(cwd, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(join(scriptsDir, "render.sh"), "#!/bin/sh\nprintf ok > out.txt\n");
    const manifest = {
      ...BASE,
      provides: {
        ...BASE.provides,
        resources: [{
          id: "tracks",
          title: "Tracks",
          kind: "virtual",
          resolver: "compute.run",
          params: {
            table: "tracks",
            command: ["sh", "-c", "scripts/render.sh"],
            resultTable: "artifacts",
            outputs: [{ name: "render", path: "out.txt", kind: "file" }],
          },
        }],
      },
    };
    await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cmdpath-cas-")));
    const out = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: "manifest.json",
      manifestBaseDir: cwd,
      sql: "SELECT * FROM tracks",
      compute: { runner: nodeComputeRunner() },
      cas,
      runId: "cmdpath1",
      now: "T1",
    });
    assert.equal(out.ok, false, "non-dot-relative command strings should not be resolved to host manifest files");
    assert.match(String((out as { error?: unknown }).error ?? ""), /scripts\/render\.sh/);
  });

  test("a spawned child does NOT see host process.env secrets, but DOES get explicit spec.env + a resolvable PATH", async () => {
    process.env.PI_BIO_FAKE_SECRET = "topsecret-do-not-leak";
    try {
      const res = await collectComputeTask(nodeComputeRunner(), {
        command: [process.execPath, "-e", "process.stdout.write(`secret=${process.env.PI_BIO_FAKE_SECRET ?? 'ABSENT'} knob=${process.env.TOOL_KNOB ?? 'unset'}`)"],
        env: { TOOL_KNOB: "on" },
      });
      assert.match(res.stdout, /secret=ABSENT/, "the host secret must NOT reach an agent-declared child (injected-effect boundary)");
      assert.match(res.stdout, /knob=on/, "explicit spec.env IS passed through");
    } finally { delete process.env.PI_BIO_FAKE_SECRET; }
  });

  test("SECURITY: an ALREADY-aborted signal prevents the SPAWN entirely — no immediate side effects", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-abort-"));
    const marker = join(dir, "side_effect");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => collectComputeTask(nodeComputeRunner(), { command: ["sh", "-c", `touch ${marker}; sleep 10`], signal: ac.signal }),
      /already aborted|not spawning/,
    );
    await new Promise((r) => setTimeout(r, 50)); // give a (wrongly) spawned child time to run its side effect
    await assert.rejects(() => fs.access(marker), /ENOENT/, "the aborted process never spawned, so it never touched the marker");
  });

  test("compute runner is future-shaped: submit returns before collect resolves, then local state is evicted", async () => {
    const runner = nodeComputeRunner();
    const handle = await runner.submit({
      command: [process.execPath, "-e", "setTimeout(() => process.stdout.write('done'), 120)"],
    });
    const status = await runner.status(handle);
    assert.equal(status?.phase, "running", "status is observable before the value is collected");
    const result = await runner.collect(handle);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "done");
    assert.equal(await runner.status(handle), null, "the local runner should not retain collected stdout/stderr forever");
  });
});

const BASE = {
  schema: "pi-bio.manifest.v1", id: "compute-guards", version: "0.1.0",
  title: "compute.run param guards", description: "fail-closed param validation for compute.run",
  provides: {
    resolvers: [{ id: "compute.run", version: "0.1.0", title: "compute", description: "compute", output: { mode: "table" } }],
  },
};

async function runWith(params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-guards-"));
  const manifest = { ...BASE, provides: { ...BASE.provides, resources: [{ id: "r", title: "r", kind: "virtual", resolver: "compute.run", params }] } };
  await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest));
  const out = await runBioQueryFromManifest({
    cwd, dbPath: ":memory:", manifestPath: "manifest.json",
    sql: "SELECT * FROM r",
    compute: { runner: nodeComputeRunner() }, // runner bound — but validation throws before it ever spawns
    runId: "g1", now: "T1",
  });
  return out.ok ? { ok: true } : { ok: false, error: (out as { error?: unknown }).error != null ? String((out as { error: unknown }).error) : "" };
}

describe("compute.run: fail-closed param guards (no spawn, no R)", () => {
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

  test("maxOutputBytes must be a positive number (fail closed)", async () => {
    const out = await runWith({ ...good, maxOutputBytes: -1 });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /maxOutputBytes must be a positive number/);
  });

  test("an optional declared-output byte quota is enforced before capture", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-guards-cap-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const params = { table: "r", resultTable: "artifacts", command: ["sh", "-c", "printf hello > out.txt"], outputs: [{ name: "o", path: "out.txt" }], maxOutputBytes: 1 };
    const manifest = { ...BASE, provides: { ...BASE.provides, resources: [{ id: "r", title: "r", kind: "virtual", resolver: "compute.run", params }] } };
    await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", sql: "SELECT * FROM r", compute: { runner: nodeComputeRunner() }, cas, runId: "cap1", now: "T1" });
    assert.equal(out.ok, false, "the 5-byte output exceeds the 1-byte quota");
    assert.match(String((out as { error?: unknown }).error ?? ""), /over the 1-byte quota/);
  });
});
