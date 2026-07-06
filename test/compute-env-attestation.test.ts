import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeComputeRunner, withObservedEnvironment } from "../src/process/node-compute-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { ComputeRunner } from "../src/core/ports.js";
import type { EnvDescriptor } from "../src/core/reproducibility.js";

// C1b: compute.run records a declared-vs-observed ENVIRONMENT ATTESTATION in the receipt. The observed side
// comes from the runner's optional describeEnvironment probe; absent probe => explicit 'unknown', never a fake pin.
type ProvEntry = { source: string; digest?: string; notes?: string[] };
type Receipt = { resourceId: string; provenance: ProvEntry[] };

async function runInline(runner: ComputeRunner, environment?: unknown): Promise<ProvEntry> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-env-"));
  const manifest = {
    schema: "pi-bio.manifest.v1", id: "env-test", version: "0.0.0", title: "x", description: "x",     provides: {
      resolvers: [{ id: "compute.run", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
      resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "compute.run", params: {
        table: "tracks", command: ["sh", "-c", "printf hi > o.txt"], resultTable: "artifacts",
        outputs: [{ name: "o", path: "o.txt", kind: "file" }], ...(environment ? { environment } : {}),
      } }],
    },
  };
  const mpath = join(cwd, "manifest.json");
  await fs.writeFile(mpath, JSON.stringify(manifest));
  const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-env-cas-")));
  const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks", compute: { runner }, cas, runId: "env", now: "T1" });
  assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
  const receipts = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "receipts.json"), "utf8")) as Receipt[];
  const env = receipts.find((r) => r.resourceId === "tracks")!.provenance.find((p) => p.source === "environment");
  assert.ok(env, "an 'environment' provenance entry is always recorded");
  return env;
}

const declaredEnv = { schema: "pi-bio.env_descriptor.v1", kind: "composite", layers: [{ kind: "executable", name: "sh", version: "5.0" }] };
const declaredRStyleEnv: EnvDescriptor = {
  schema: "pi-bio.env_descriptor.v1",
  kind: "composite",
  layers: [
    { kind: "executable", name: "Rscript", version: "4.4.0" },
    { kind: "package_lock", manager: "renv", path: "renv.lock", digest: `sha256:${"a".repeat(64)}` },
    { kind: "package_snapshot", manager: "renv", packages: [{ name: "nanoarrow", version: "0.7.0" }, { name: "coloc", version: "5.2.3" }] },
  ],
};
const noProbeRunner = (): ComputeRunner => {
  const runner = nodeComputeRunner();
  return {
    submit: runner.submit,
    status: runner.status,
    collect: runner.collect,
    cancel: runner.cancel,
  };
}; // a runner WITHOUT describeEnvironment

describe("C1b: compute.run environment attestation in the receipt", () => {
  test("with a probing runner and NO declaration -> observed_only, an observed digest is recorded", async () => {
    const env = await runInline(nodeComputeRunner());
    assert.ok(env.notes?.includes("env_status:observed_only"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => /^env_observed:sha256:[0-9a-f]{64}$/.test(n)), "observed digest recorded");
    assert.ok(!env.notes?.some((n) => n.startsWith("env_declared:")), "no declaration");
  });

  test("with a probing runner AND a differing declaration -> drift, both digests recorded", async () => {
    const env = await runInline(nodeComputeRunner(), declaredEnv);
    assert.ok(env.notes?.includes("env_status:drift"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => n.startsWith("env_declared:sha256:")));
    assert.ok(env.notes?.some((n) => n.startsWith("env_observed:sha256:")));
  });

  test("a host-observed package environment can match the declared reproduction contract", async () => {
    const runner = withObservedEnvironment(nodeComputeRunner(), declaredRStyleEnv);
    const env = await runInline(runner, declaredRStyleEnv);
    assert.ok(env.notes?.includes("env_status:matched"), env.notes?.join(","));
    const declared = env.notes?.find((n) => n.startsWith("env_declared:sha256:"));
    const observed = env.notes?.find((n) => n.startsWith("env_observed:sha256:"));
    assert.ok(declared);
    assert.ok(observed);
    assert.equal(declared.replace("env_declared:", ""), observed.replace("env_observed:", ""));
  });

  test("the observed-environment provider can derive per-command descriptors or delegate to the wrapped runner", async () => {
    const derived: EnvDescriptor = {
      schema: "pi-bio.env_descriptor.v1",
      kind: "composite",
      layers: [{ kind: "executable", name: "sh" }, { kind: "module", name: "analysis-stack", version: "2026.07" }],
    };
    const calls: string[][] = [];
    const runner = withObservedEnvironment(nodeComputeRunner(), (spec) => {
      calls.push([...spec.command]);
      return spec.command[0] === "sh" ? derived : undefined;
    });

    const matched = await runInline(runner, derived);
    assert.ok(matched.notes?.includes("env_status:matched"), matched.notes?.join(","));
    assert.deepEqual(calls.map((c) => c[0]), ["sh"]);

    const delegated = await runner.describeEnvironment?.({ command: ["not-sh"], cwd: ".", timeoutMs: 1 });
    assert.deepEqual(calls.map((c) => c[0]), ["sh", "not-sh"]);
    assert.equal(delegated?.kind, "composite");
    assert.ok(delegated?.layers.some((l) => l.kind === "executable" && l.name === "not-sh"), "undefined delegates to wrapped probe");
  });

  test("a runner with NO describeEnvironment probe -> explicit unknown (no declaration), never a fake pin", async () => {
    const env = await runInline(noProbeRunner());
    assert.ok(env.notes?.includes("env_status:unknown"), env.notes?.join(","));
    assert.equal(env.digest, undefined, "unknown env carries no pinned digest");
  });

  test("a runner with no probe but a DECLARED env -> declared_only (intent recorded, execution not observed)", async () => {
    const env = await runInline(noProbeRunner(), declaredEnv);
    assert.ok(env.notes?.includes("env_status:declared_only"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => n.startsWith("env_declared:sha256:")));
    assert.ok(!env.notes?.some((n) => n.startsWith("env_observed:")));
  });

  test("an invalid declared EnvDescriptor fails closed", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-env-"));
    const manifest = {
      schema: "pi-bio.manifest.v1", id: "env-bad", version: "0.0.0", title: "x", description: "x",       provides: {
        resolvers: [{ id: "compute.run", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
        resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "compute.run", params: {
          table: "tracks", command: ["sh", "-c", "printf hi > o.txt"], resultTable: "artifacts",
          outputs: [{ name: "o", path: "o.txt", kind: "file" }], environment: { schema: "pi-bio.env_descriptor.v1", kind: "composite", layers: [] }, // empty composite = invalid
        } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-env-cas-")));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks", compute: { runner: nodeComputeRunner() }, cas, runId: "envbad", now: "T1" });
    assert.equal(out.ok, false, "an invalid declared EnvDescriptor must fail closed");
  });

  test("an invalid host-observed descriptor degrades to explicit unknown", async () => {
    const runner = withObservedEnvironment(nodeComputeRunner(), { schema: "pi-bio.env_descriptor.v1", kind: "composite", layers: [] } as never);
    const env = await runInline(runner);
    assert.ok(env.notes?.includes("env_status:unknown"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => /withObservedEnvironment: invalid EnvDescriptor/.test(n)), env.notes?.join(","));
  });
});
