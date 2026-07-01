import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { ProcessRunner } from "../src/core/ports.js";

// C1b: process.compute records a declared-vs-observed ENVIRONMENT ATTESTATION in the receipt. The observed side
// comes from the runner's optional describeEnvironment probe; absent probe => explicit 'unknown', never a fake pin.
type ProvEntry = { source: string; digest?: string; notes?: string[] };
type Receipt = { resourceId: string; provenance: ProvEntry[] };

async function runInline(runner: ProcessRunner, environment?: unknown): Promise<ProvEntry> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-env-"));
  const manifest = {
    schema: "pi-bio.domain_pack_manifest.v1", id: "env-test", version: "0.0.0", title: "x", description: "x", domains: ["statistics"],
    provides: {
      resolvers: [{ id: "process.compute", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
      resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "process.compute", params: {
        table: "tracks", command: ["sh", "-c", "printf hi > o.txt"], resultTable: "artifacts",
        outputs: [{ name: "o", path: "o.txt", kind: "file" }], ...(environment ? { environment } : {}),
      } }],
    },
  };
  const mpath = join(cwd, "manifest.json");
  await fs.writeFile(mpath, JSON.stringify(manifest));
  const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-env-cas-")));
  const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks", process: { runner }, cas, runId: "env", now: "T1" });
  assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
  const receipts = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "receipts.json"), "utf8")) as Receipt[];
  const env = receipts.find((r) => r.resourceId === "tracks")!.provenance.find((p) => p.source === "environment");
  assert.ok(env, "an 'environment' provenance entry is always recorded");
  return env;
}

const declaredEnv = { schema: "pi-bio.env_descriptor.v1", kind: "composite", layers: [{ kind: "executable", name: "sh", version: "5.0" }] };
const noProbeRunner = (): ProcessRunner => ({ run: nodeProcessRunner().run }); // a runner WITHOUT describeEnvironment

describe("C1b: process.compute environment attestation in the receipt", () => {
  test("with a probing runner and NO declaration -> observed_only, an observed digest is recorded", async () => {
    const env = await runInline(nodeProcessRunner());
    assert.ok(env.notes?.includes("env_status:observed_only"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => /^env_observed:sha256:[0-9a-f]{64}$/.test(n)), "observed digest recorded");
    assert.ok(!env.notes?.some((n) => n.startsWith("env_declared:")), "no declaration");
  });

  test("with a probing runner AND a differing declaration -> drift, both digests recorded", async () => {
    const env = await runInline(nodeProcessRunner(), declaredEnv);
    assert.ok(env.notes?.includes("env_status:drift"), env.notes?.join(","));
    assert.ok(env.notes?.some((n) => n.startsWith("env_declared:sha256:")));
    assert.ok(env.notes?.some((n) => n.startsWith("env_observed:sha256:")));
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
      schema: "pi-bio.domain_pack_manifest.v1", id: "env-bad", version: "0.0.0", title: "x", description: "x", domains: ["statistics"],
      provides: {
        resolvers: [{ id: "process.compute", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
        resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "process.compute", params: {
          table: "tracks", command: ["sh", "-c", "printf hi > o.txt"], resultTable: "artifacts",
          outputs: [{ name: "o", path: "o.txt", kind: "file" }], environment: { schema: "pi-bio.env_descriptor.v1", kind: "composite", layers: [] }, // empty composite = invalid
        } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-env-cas-")));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks", process: { runner: nodeProcessRunner() }, cas, runId: "envbad", now: "T1" });
    assert.equal(out.ok, false, "an invalid declared EnvDescriptor must fail closed");
  });
});
