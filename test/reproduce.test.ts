import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { reproduceRun } from "../src/hosts/reproduce.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { RunReplaySpec } from "../src/core/reproducibility.js";

// C2 — reproduce(): re-execute a RunReplaySpec against a fresh db and compare the produced receipts' DETERMINISTIC
// content digests to the spec's sourceReceiptDigests. Same inputs -> matched (clock differences don't count as
// drift); a tampered pin -> honest mismatch; a replay with nothing to verify -> fail closed.
const MANIFEST = resolve(process.cwd(), "examples", "variant-counts", "manifest.json"); // absolute: resources resolve to its dir
const SQL = "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence";

async function runOnce(): Promise<{ cwd: string; replay: RunReplaySpec }> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-"));
  const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, runId: "orig", now: "2026-07-01T00:00:00Z" });
  assert.equal(out.ok, true, out.ok ? "" : `orig run failed: ${(out as { error?: unknown }).error}`);
  const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
  return { cwd, replay };
}

describe("C2: reproduce() compares deterministic receipt content, not wall-clock", () => {
  test("re-running the same inputs matches the pinned digests (a different resolvedAt is NOT drift)", async () => {
    const { cwd, replay } = await runOnce();
    assert.ok((replay.sourceReceiptDigests ?? []).length > 0, "the original run pinned receipt digests");
    const rep = await reproduceRun({ cwd, replay });
    assert.equal(rep.reproduced, true, rep.error);
    assert.equal(rep.matched, true, `unexpected drift: missing=${JSON.stringify(rep.missing)} extra=${JSON.stringify(rep.extra)}`);
    assert.deepEqual(rep.missing, []);
    assert.deepEqual(rep.extra, []);
  });

  test("a tampered pin is honest drift (missing the expected, extra the produced)", async () => {
    const { cwd, replay } = await runOnce();
    const tampered: RunReplaySpec = { ...replay, sourceReceiptDigests: ["sha256:" + "0".repeat(64)] };
    const rep = await reproduceRun({ cwd, replay: tampered });
    assert.equal(rep.reproduced, true);
    assert.equal(rep.matched, false, "a bogus expected digest must not match");
    assert.deepEqual(rep.missing, ["sha256:" + "0".repeat(64)], "the bogus expected digest is reported missing");
    assert.ok(rep.extra.length > 0, "the real produced digests are reported extra");
  });

  test("compares OUTPUT content: a matching result digest -> resultMatched; a tampered one -> matched=false", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-cas-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, cas, runId: "origc", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
    assert.match(replay.resultDigest ?? "", /^sha256:/, "a CAS-backed run pins the result-content digest");

    const rep = await reproduceRun({ cwd, replay, cas });
    assert.equal(rep.matched, true);
    assert.equal(rep.resultMatched, true, "the re-run's result content matched the pinned digest");
    assert.equal(rep.producedResultDigest, replay.resultDigest);

    // a re-run whose OUTPUT differs from the pin is caught even if receipts match (the 'matches by content' claim)
    const wrongOutput: RunReplaySpec = { ...replay, resultDigest: "sha256:" + "0".repeat(64) };
    const drift = await reproduceRun({ cwd, replay: wrongOutput, cas });
    assert.equal(drift.resultMatched, false, "a different result content is caught");
    assert.equal(drift.matched, false, "matched=false when the output content drifted, even with matching receipts");
  });

  test("duckdbConfig reproducibility: replay pins the config DIGEST; reproduce must re-supply a matching config", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-cfg-"));
    const duckdbConfig = { threads: "2" };
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, duckdbConfig, runId: "origcfg", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
    assert.match(replay.duckdbConfigDigest ?? "", /^sha256:/, "the config's DIGEST is pinned (not the secret-bearing config itself)");

    await assert.rejects(() => reproduceRun({ cwd, replay }), /re-supply the same duckdbConfig/); // no config -> refuse
    await assert.rejects(() => reproduceRun({ cwd, replay, duckdbConfig: { threads: "8" } }), /does not match the pinned duckdbConfigDigest/); // wrong config -> refuse
    const rep = await reproduceRun({ cwd, replay, duckdbConfig }); // matching config -> reproduces
    assert.equal(rep.matched, true);
  });

  test("fail closed: reproduce rejects when the manifest FILE changed since the run (would run different logic)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-drift-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify({ schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} }));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT 1 AS x", cas, runId: "drift1", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
    // an EDIT to the manifest after the run — reproduce must refuse (its digest no longer matches the pin)
    await fs.writeFile(mpath, JSON.stringify({ schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "CHANGED", description: "m", provides: {} }));
    await assert.rejects(() => reproduceRun({ cwd, replay, cas }), /manifest .* has CHANGED/);
  });

  test("fail closed: a replay with no pinned digests, or no manifest path, refuses (no hollow match)", async () => {
    const { cwd, replay } = await runOnce();
    await assert.rejects(() => reproduceRun({ cwd, replay: { ...replay, sourceReceiptDigests: [], resultDigest: undefined } }), /pins neither sourceReceiptDigests nor a resultDigest/);
    await assert.rejects(() => reproduceRun({ cwd, replay: { ...replay, manifest: undefined } }), /no manifest to re-run/);
  });
});
