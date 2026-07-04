import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioOperationFromManifest, runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { reproduceRun } from "../src/hosts/reproduce.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";
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

  test("(#2) compares the observed ENVIRONMENT: env drift is caught even when receipts + result content match", async () => {
    // A process.compute run's env attestation lives in the receipt's provenance NOTES, which receiptContentDigest
    // DROPS — so a re-run under a different environment but identical output would falsely 'match' on receipts+result
    // alone. reproduce recomputes the re-run's observed env and compares it to the pinned observedDigest.
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-env-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, cas, runId: "origenv", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;

    // no env pinned (a pure-SQL run has none): environmentMatched is undefined and does NOT drag matched down
    const base = await reproduceRun({ cwd, replay, cas });
    assert.equal(base.matched, true);
    assert.equal(base.environmentMatched, undefined, "no env pin -> no env check, matched stands on receipts+result");

    // pin an observed env fingerprint the re-run cannot reproduce (this pure-SQL re-run observes NO env): drift.
    const pinnedEnv: RunReplaySpec = { ...replay, environment: { status: "observed_only", observedDigest: "sha256:" + "a".repeat(64) } };
    const rep = await reproduceRun({ cwd, replay: pinnedEnv, cas });
    assert.equal(rep.environmentMatched, false, "the pinned observed env was not reproduced -> env drift");
    assert.equal(rep.matched, false, "matched=false on env drift even though receipts + result content matched");
    assert.equal(rep.expectedEnvDigest, "sha256:" + "a".repeat(64));
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

  test("SECURITY: duckdbInitSql is NOT persisted verbatim (secret leak) — only its digest is pinned; reproduce re-supplies + verifies", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-init-"));
    // Deliberately credential-like to prove replay redaction. This is not a recommended auth shape for generic
    // agent SQL: the same connection can read getvariable('secret_token') unless the host declares it protected.
    const duckdbInitSql = ["SET VARIABLE secret_token = 'Bearer super-secret-xyz'"];
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, duckdbInitSql, runId: "originit", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    const replayText = await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8");
    assert.doesNotMatch(replayText, /super-secret-xyz/, "the secret in init SQL must NOT leak into replay.json");
    const replay = JSON.parse(replayText) as RunReplaySpec;
    assert.match(replay.duckdbInitSqlDigest ?? "", /^sha256:/, "only the init-SQL DIGEST is pinned");
    assert.equal((replay as { duckdbInitSql?: unknown }).duckdbInitSql, undefined, "the raw init SQL is not stored");

    await assert.rejects(() => reproduceRun({ cwd, replay }), /re-supply the same duckdbInitSql/); // no init SQL -> refuse
    await assert.rejects(() => reproduceRun({ cwd, replay, duckdbInitSql: ["SET VARIABLE secret_token = 'other'"] }), /does not match the pinned duckdbInitSqlDigest/); // wrong -> refuse
    const rep = await reproduceRun({ cwd, replay, duckdbInitSql }); // matching init SQL -> reproduces
    assert.equal(rep.matched, true);
  });

  test("SECURITY: protectedSessionBindings are not persisted verbatim; reproduce re-supplies + verifies their digest", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-protected-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const manifestPath = join(cwd, "manifest.json");
    const manifest = {
      schema: "pi-bio.manifest.v1",
      id: "protected-repro",
      version: "0.1.0",
      title: "Protected replay",
      description: "Declared operation over host-owned protected session state.",
      provides: {
        operations: [{
          id: "host_auth.read",
          version: "0.1.0",
          title: "Host auth read",
          description: "Reads a host-owned protected binding in a declared operation.",
          transport: "duckdb.sql",
          inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT getvariable('api_token') AS token", readOnly: true },
        }],
      },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const protectedSessionBindings = { api_token: "Bearer reproduce-token" };
    const out = await runBioOperationFromManifest({
      cwd, dbPath: ":memory:", manifestPath, operationId: "host_auth.read",
      protectedSessionBindings, cas, runId: "origprotected", now: "2026-07-01T00:00:00Z",
    });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    const replayText = await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8");
    assert.doesNotMatch(replayText, /reproduce-token/, "protected binding value must not leak into replay.json");
    const replay = JSON.parse(replayText) as RunReplaySpec;
    assert.match(replay.protectedSessionBindingsDigest ?? "", /^sha256:/, "only the protected binding digest is pinned");
    assert.match(replay.resultDigest ?? "", /^sha256:/, "CAS pins the output content for this resource-free op");

    await assert.rejects(() => reproduceRun({ cwd, replay, cas }), /re-supply the same protectedSessionBindings/);
    await assert.rejects(
      () => reproduceRun({ cwd, replay, cas, protectedSessionBindings: { api_token: "Bearer wrong" } }),
      /do not match the pinned protectedSessionBindingsDigest/,
    );
    const rep = await reproduceRun({ cwd, replay, cas, protectedSessionBindings });
    assert.equal(rep.matched, true);
    assert.equal(rep.resultMatched, true);
  });

  test("NOT_REPRODUCIBLE (never fake confidence): an un-snapshotted live source with no result pin does not falsely 'match'", async () => {
    // duckdb.sql_materialize over read_csv_auto records NO source version, so its receipt digest is blind to the
    // file's CONTENT. Without a CAS resultDigest, a receipts-only 'match' would be hollow — reproduce must say so.
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-live-"));
    const dataPath = join(cwd, "data.csv").replace(/\\/g, "/");
    await fs.writeFile(dataPath, "x\n1\n2\n");
    const manifest = {
      schema: "pi-bio.manifest.v1", id: "live", version: "0.1.0", title: "live", description: "live",
      provides: {
        resolvers: [{ id: "duckdb.sql_materialize", version: "0.1.0", title: "m", description: "m", output: { mode: "table" } }],
        resources: [{ id: "live", title: "live", kind: "virtual", resolver: "duckdb.sql_materialize", params: { table: "live", sql: `SELECT * FROM read_csv_auto('${dataPath}')` } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT count(*) AS n FROM live", resources: ["live"], runId: "live1", now: "2026-07-01T00:00:00Z" }); // no cas
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
    assert.equal(replay.resultDigest, undefined, "no CAS -> no output content pin");

    const rep = await reproduceRun({ cwd, replay }); // no cas on reproduce either
    assert.equal(rep.reproduced, true, "the re-run itself completed");
    assert.equal(rep.matched, false, "an un-content-verified live source must NOT report matched:true");
    assert.match(rep.notReproducible ?? "", /un-snapshotted live source/, "honest: not_reproducible with a reason");
  });

  test("(#2) a process.compute run declares live_source so reproduce won't fake-match it without a CAS output pin", async () => {
    // process.compute receipts pin command/input/env but NOT the output table's content, and a script can be
    // non-deterministic — so its provenance carries the `live_source` marker (same mechanism as sql_materialize),
    // which drives reproduce's not_reproducible verdict (proven end-to-end by the sql_materialize test above). Here
    // we assert the marker IS emitted. (files-only needs a CAS for its artifacts, so this run has one — but the
    // marker is what matters; the reproduce LOGIC over the marker is already covered.)
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-proc-"));
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const FILES_ONLY = resolve(process.cwd(), "examples", "process-files-only", "manifest.json");
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: FILES_ONLY, sql: "SELECT name FROM tracks ORDER BY name", process: { runner: nodeProcessRunner() }, cas, runId: "proc1", now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    const receipts = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "receipts.json"), "utf8")) as Array<{ provenance: Array<{ source: string; notes?: string[] }> }>;
    const proc = receipts.flatMap((r) => r.provenance).find((p) => p.source === "process.compute");
    assert.ok(proc?.notes?.includes("live_source"), "process.compute provenance marks live_source (output not content-pinned)");
  });

  test("a near-max-length original runId still reproduces — the derived 'reproduce-…' id is bounded to the 128-char limit", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-repro-longid-"));
    const longRunId = "r".repeat(120); // valid (<=128) but close to the max
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: SQL, runId: longRunId, now: "2026-07-01T00:00:00Z" });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    const replay = JSON.parse(await fs.readFile(join((out as { runDir: string }).runDir, "replay.json"), "utf8")) as RunReplaySpec;
    const rep = await reproduceRun({ cwd, replay }); // must NOT throw on a too-long derived runId
    assert.equal(rep.reproduced, true, rep.error);
    assert.equal(rep.matched, true, "the run reproduces despite a long original runId (derived id was bounded, not rejected)");
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
