import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

// C1b-ii: every run seeds replay.json — the ACTUAL replay inputs C2's reproduce() will re-execute (not just
// digests). For compute ops it captures BOTH the authored manifest snapshot (portable, relative ./render.sh) and
// the resolved execution facts (this host's absolute command path).
const FILES_ONLY = resolve(process.cwd(), "examples", "compute-files-only", "manifest.json");

async function readReplay(runDir: string): Promise<RunReplaySpec> {
  return JSON.parse(await fs.readFile(join(runDir, "replay.json"), "utf8")) as RunReplaySpec;
}

describe("C1b-ii: replay.json seed", () => {
  test("a compute-backed query persists replay.json with authored snapshot + resolved compute facts", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-replay-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-replay-cas-")));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: FILES_ONLY,
      sql: "SELECT name FROM tracks ORDER BY name",
      compute: { runner: nodeComputeRunner() }, cas, runId: "r1", now: "T1",
    });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    if (!out.ok) return;

    const replay = await readReplay(out.runDir);
    assert.equal(replay.schema, "pi-bio.run_replay_spec.v1");
    assert.equal(replay.kind, "query");
    assert.equal(replay.sql, "SELECT name FROM tracks ORDER BY name", "the actual SQL is a replay input");
    assert.match(replay.manifest!.digest, /^sha256:[0-9a-f]{64}$/);

    // authored snapshot keeps the PORTABLE relative command (./render.sh) — the replay intent
    const authored = replay.manifest!.snapshot as { provides: { resources: Array<{ params: { command: string[] } }> } };
    assert.deepEqual(authored.provides.resources[0].params.command, ["sh", "./render.sh"], "authored command stays relative (portable)");

    // resolved compute facts carry THIS host's absolute path (what actually ran) — both are stored
    assert.equal(replay.compute!.resourceId, "tracks");
    assert.equal(replay.compute!.resultTable, "artifacts");
    assert.equal(replay.compute!.command![0], "sh");
    assert.ok(isAbsolute(replay.compute!.command![1] as string), "resolved command path is absolute (execution fact)");
    assert.equal(replay.compute!.command![1], resolve(process.cwd(), "examples", "compute-files-only", "render.sh"));

    // C1b-iii enrichment: receipts exist now, so replay is pinned to their digests + carries the env summary
    assert.ok(Array.isArray(replay.sourceReceiptDigests) && replay.sourceReceiptDigests.length > 0, "receipt digests pinned");
    assert.ok(replay.sourceReceiptDigests!.every((d) => /^sha256:[0-9a-f]{64}$/.test(d)));
    assert.ok(replay.environment, "env attestation summary present");
    assert.equal(replay.environment!.status, "observed_only", "nodeComputeRunner probed, no declaration");
    assert.match(replay.environment!.observedDigest!, /^sha256:[0-9a-f]{64}$/);
  });

  test("a plain (non-compute) query persists replay.json without a compute block", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-replay-"));
    const manifest = {
      schema: "pi-bio.manifest.v1", id: "vc", version: "0.0.0", title: "x", description: "x",       provides: {
        resolvers: [{ id: "duckdb.sql_materialize", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
        resources: [{ id: "nums", title: "x", kind: "virtual", resolver: "duckdb.sql_materialize", params: { table: "nums", sql: "SELECT 1 AS x" } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT x FROM nums", runId: "r2", now: "T1" });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    if (!out.ok) return;
    const replay = await readReplay(out.runDir);
    assert.equal(replay.kind, "query");
    assert.equal(replay.compute, undefined, "no compute resource -> no compute block");
    assert.equal(replay.sql, "SELECT x FROM nums");
  });
});
