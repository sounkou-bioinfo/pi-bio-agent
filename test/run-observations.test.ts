import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, materializeBioEdgesAsOf, observationAsOfKey } from "../src/duckdb/observations.js";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordRunObservation } from "../src/hosts/run-observations.js";
import { runBioQueryFromManifest, runBioOperationFromManifest, markRunDbOpenError, isRunDbOpenError, persistRun, persistFailedRun } from "../src/hosts/run-store.js";
import type { RunPayload } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { CasStore } from "../src/core/cas.js";
import { collectGarbage } from "../src/hosts/gc.js";
import { dropCasRefs } from "../src/hosts/cas-metadata.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};

describe("run-observations: ad-hoc SQL folds into the ONE store as an as-of, attributed observation", () => {
  test("a query run becomes a run:<id> observation carrying its exact SQL, status, and author", async () => {
    const c = await conn();
    await recordRunObservation(c, { runId: "q1", kind: "query", identity: "ad-hoc.query", status: "succeeded", sql: "SELECT count(*) FROM variants", resources: ["variants"], sourceReceiptDigests: ["sha256:abc"], manifestDigest: "sha256:def" }, "2026-01-01T00:00:01Z", "agent:A");
    const row = await observationAsOfKey(c, "run:q1", MEMORY_NOW);
    assert.ok(row, "the run is recorded in the store");
    assert.equal(row!.source, "agent:A"); // attributed
    const v = JSON.parse(row!.value_json!);
    assert.equal(v.status, "succeeded");
    assert.equal(v.sql, "SELECT count(*) FROM variants"); // the exact ad-hoc SQL is queryable, not just in a file
    assert.deepEqual(v.sourceReceiptDigests, ["sha256:abc"]); // the fact REFERENCES the immutable content (bytes stay outside)
    assert.equal(v.manifestDigest, "sha256:def");
  });

  test("bindings must be JSON-serializable — a bigint/NaN/undefined binding is rejected before the run (won't round-trip replay.json)", async () => {
    const base = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT 1 AS x" } as const;
    await assert.rejects(() => runBioQueryFromManifest({ ...base, bindings: { n: 10n } }), /bigint/);
    await assert.rejects(() => runBioQueryFromManifest({ ...base, bindings: { n: NaN } }), /non-finite/);
    await assert.rejects(() => runBioQueryFromManifest({ ...base, bindings: { n: undefined } }), /undefined/);
    await assert.rejects(() => runBioQueryFromManifest({ ...base, bindings: { d: new Date() } }), /non-plain object/);
    // a plain JSON binding is fine
    const ok = await runBioQueryFromManifest({ ...base, bindings: { q: "asthma", k: 3 } });
    assert.equal(ok.ok, true, ok.ok ? "" : `run failed: ${(ok as { error?: unknown }).error}`);
  });

  test("a binding whose name is a reserved SQL keyword is quoted, not a `SET VARIABLE select` syntax error", async () => {
    const base = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json" } as const;
    // `select`/`order` pass the identifier regex but are reserved keywords; before quoting, `SET VARIABLE select = ?`
    // was a syntax error that failed the run. Quoting makes it work AND `getvariable('select')` still resolves it.
    const ok = await runBioQueryFromManifest({ ...base, sql: "SELECT getvariable('select') AS s", bindings: { select: "kept", order: "x" } });
    assert.equal(ok.ok, true, ok.ok ? "" : `run failed: ${(ok as { error?: unknown }).error}`);
    assert.equal(ok.ok && ok.rowCount, 1);
  });

  test("persistRun/persistFailedRun refuse serialize:false without casBacked — lean mode can't delete provenance with no CAS", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "persist-guard-"));
    // the guard throws BEFORE touching the payload, so a stub payload is fine
    await assert.rejects(() => persistRun(cwd, "r1", {} as unknown as RunPayload, { serialize: false }), /casBacked:true only after writing those bytes to CAS/);
    await assert.rejects(() => persistFailedRun(cwd, "r1", {} as unknown as { run: never; receipts: never[] }, { serialize: false }), /casBacked/);
  });

  test("run-db-open marker: only a MARKED error is a retry-safe db-open failure; the original message is preserved", () => {
    // the extension's withRunLog retries a run unlogged ONLY for a lock at the DB OPEN (before side effects). It keys
    // on this marker AND on isBioStoreLocked (the message), so marking must not clobber the message.
    const e = new Error("IO Error: Could not set lock on file X: Conflicting lock");
    assert.equal(isRunDbOpenError(e), false, "an unmarked error is not a db-open failure (a mid-run lock is not retried)");
    const marked = markRunDbOpenError(e);
    assert.equal(isRunDbOpenError(marked), true, "a marked error is a db-open failure (safe to retry unlogged)");
    assert.equal(marked.message, "IO Error: Could not set lock on file X: Conflicting lock", "message preserved so isBioStoreLocked still classifies it");
    assert.equal(isRunDbOpenError(undefined), false);
    assert.equal(isRunDbOpenError("nope"), false);
  });

  test("recordRunObservation ensures the ledger schema on a FRESH store — the first run's fact is not silently dropped", async () => {
    // a host-injected/custom store that was NOT pre-provisioned (no createBioObservationSchema). recordRun logs
    // best-effort (swallows failures), so without an internal ensure-schema the FIRST run's fact would vanish.
    const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await recordRunObservation(c, { runId: "fresh1", kind: "query", identity: "ad-hoc.query", status: "succeeded" }, "2026-01-01T00:00:00Z", "agent:A");
    assert.ok(await observationAsOfKey(c, "run:fresh1", MEMORY_NOW), "the first run recorded even though the store started with no schema");
  });

  test("an OPERATION run records kind 'operation' (from the explicit kind, not an identity sentinel)", async () => {
    const store = await conn();
    const res = await runBioOperationFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/rare-high-impact/manifest.json", operationId: "rare_high_impact.report", store, author: "agent:test" });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    const v = JSON.parse((await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW))!.value_json!);
    assert.equal(v.kind, "operation", "a declared operation is logged as an operation, not inferred as a query");
    assert.equal(v.identity, "rare_high_impact.report");
  });

  test("a BACKDATED re-run of the same runId still SUPERSEDES in the ledger (monotonic) — no stale-digest current fact", async () => {
    const c = await conn();
    // first run at T2 pins digest 'new-ish'; a REUSED runId re-run arrives BACKDATED at T1 (< T2) with fresh digests
    await recordRunObservation(c, { runId: "r", kind: "query", identity: "ad-hoc.query", status: "succeeded", resultDigest: "sha256:" + "1".repeat(64) }, "2026-01-01T00:00:02Z", "agent:A");
    await recordRunObservation(c, { runId: "r", kind: "query", identity: "ad-hoc.query", status: "succeeded", resultDigest: "sha256:" + "2".repeat(64) }, "2026-01-01T00:00:01Z", "agent:B");
    const v = JSON.parse((await observationAsOfKey(c, "run:r", MEMORY_NOW))!.value_json!);
    assert.equal(v.resultDigest, "sha256:" + "2".repeat(64), "the LATER re-run's fact is current — the backdated write was advanced past the prior, not left stale");
  });

  test("a real run records its run:<id> fact DIRECTLY into the store (no file read-back), with actual digests", async () => {
    const store = await conn();
    const res = await runBioQueryFromManifest({
      cwd: process.cwd(),
      dbPath: ":memory:",
      manifestPath: "examples/variant-counts/manifest.json",
      sql: "SELECT count(*) AS n FROM variants",
      store,
      author: "agent:test",
    });
    const row = await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW);
    assert.ok(row, "the run recorded itself into the passed-in store");
    assert.equal(row!.source, "agent:test");
    const v = JSON.parse(row!.value_json!);
    assert.equal(v.status, "succeeded");
    assert.equal(v.sql, "SELECT count(*) AS n FROM variants");
    assert.ok(Array.isArray(v.sourceReceiptDigests) && v.sourceReceiptDigests.length >= 1, "digest refs came from the ACTUAL run's receipts, not a re-read file");
  });

  test("two runs do not clash: auto-generated run ids are globally unique (safe in a shared store)", async () => {
    const store = await conn();
    const base = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:test" } as const;
    const a = await runBioQueryFromManifest({ ...base });
    const b = await runBioQueryFromManifest({ ...base });
    assert.notEqual(a.runId, b.runId, "distinct run ids -> distinct run:<id> slots, no supersession clash");
    assert.ok(await observationAsOfKey(store, `run:${a.runId}`, MEMORY_NOW));
    assert.ok(await observationAsOfKey(store, `run:${b.runId}`, MEMORY_NOW));
  });

  test("result rows go to CAS by digest; the run fact references them (bytes OUTSIDE the DB)", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:test", cas });
    const row = await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW);
    const v = JSON.parse(row!.value_json!);
    assert.match(v.resultDigest, /^sha256:[a-f0-9]{64}$/); // the fact REFERENCES the result by content digest
    const digest = v.resultDigest.slice("sha256:".length);
    assert.equal(await cas.has({ algorithm: "sha256", digest }), true); // and the bytes actually live in CAS, not the DB
  });

  test("lean mode (serialize:false) skips result/receipts/replay FILES; their bytes are in CAS, referenced by casRefs + the fact", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas, serialize: false });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // run.json + cas-refs.json (the GC root list) on disk — no result.json / receipts.json / replay.json (bytes in CAS)
    assert.deepEqual((await fsp.readdir(res.runDir)).sort(), ["cas-refs.json", "run.json"]);

    // DATA-LOSS GUARD: node-local GC must NOT sweep the lean run's CAS bytes — cas-refs.json roots them (there is
    // no receipts.json to root from). Point the GC at THIS run's dir + cas root.
    const cwdOfRun = res.runDir.slice(0, res.runDir.indexOf("/.pi/"));
    const casRoot = (cas as unknown as { pathFor: (a: { algorithm: string; digest: string }) => string }).pathFor({ algorithm: "sha256", digest: "a".repeat(64) }).replace(/\/sha256\/.*$/, "");
    await collectGarbage(cwdOfRun, { casRoot, minAgeMs: 0 });
    const rd = res.casRefs!.result!.slice("sha256:".length);
    assert.equal(await cas.has({ algorithm: "sha256", digest: rd }), true, "lean run's result CAS bytes survived GC (cas-refs.json rooted them)");
    assert.ok(res.casRefs && res.casRefs.result && res.casRefs.receipts && res.casRefs.replay);
    for (const ref of [res.casRefs.result, res.casRefs.receipts, res.casRefs.replay]) {
      assert.match(ref!, /^sha256:[a-f0-9]{64}$/);
      assert.equal(await cas.has({ algorithm: "sha256", digest: ref!.slice(7) }), true); // bytes are in CAS
    }
    const v = JSON.parse((await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW))!.value_json!);
    assert.equal(v.receiptsDigest, res.casRefs.receipts); // the run fact references receipts + replay by digest
    assert.equal(v.replayDigest, res.casRefs.replay);

    // CRASH-SAFETY: run.json is written BEFORE cas-refs.json — simulate a crash in that gap by DELETING cas-refs.json.
    // GC must STILL keep the result bytes alive by rooting from run.json's `cas:<digest>` artifact (not just cas-refs).
    await fsp.rm(join(res.runDir, "cas-refs.json"), { force: true });
    await collectGarbage(cwdOfRun, { casRoot, minAgeMs: 0 });
    assert.equal(await cas.has({ algorithm: "sha256", digest: rd }), true, "result bytes survive GC even with cas-refs.json missing — run.json roots them");
  });

  test("DATA-LOSS: a FAILED lean+CAS run also writes cas-refs.json so GC doesn't sweep its receipts/replay bytes", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    // a runtime failure (unknown column) under serialize:false + CAS — receipts/replay bytes go to CAS, no JSON files
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT nope FROM variants", store, author: "agent:A", cas, serialize: false });
    assert.equal(res.ok, false, "the bad SQL fails at runtime");
    // the failed run's dir carries cas-refs.json (the GC root) even though there's no receipts.json in lean mode
    assert.ok((await fsp.readdir(res.runDir)).includes("cas-refs.json"), "a failed lean run roots its CAS bytes in cas-refs.json");
    assert.ok(res.casRefs && res.casRefs.receipts && res.casRefs.replay);

    const cwdOfRun = res.runDir.slice(0, res.runDir.indexOf("/.pi/"));
    const casRoot = (cas as unknown as { pathFor: (a: { algorithm: string; digest: string }) => string }).pathFor({ algorithm: "sha256", digest: "a".repeat(64) }).replace(/\/sha256\/.*$/, "");
    await collectGarbage(cwdOfRun, { casRoot, minAgeMs: 0 });
    for (const ref of [res.casRefs.receipts, res.casRefs.replay]) {
      assert.equal(await cas.has({ algorithm: "sha256", digest: ref!.slice(7) }), true, "the failed run's CAS bytes survived GC (cas-refs.json rooted them)");
    }
  });

  test("run-as-object-DAG: two identical runs share one runObjectDigest (CAS object root — dedup by hash)", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const req = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas } as const;
    const a = await runBioQueryFromManifest({ ...req });
    const b = await runBioQueryFromManifest({ ...req });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.match(a.casRefs!.runObject!, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(a.runId, b.runId); // different ledger keys...
    assert.equal(a.casRefs!.runObject, b.casRefs!.runObject); // ...but ONE content-addressed run DAG root
    assert.equal(await cas.has({ algorithm: "sha256", digest: a.casRefs!.runObject!.slice(7) }), true);
  });

  test("run CAS outputs automatically register cas_object rows and run refs for metadata GC", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-meta-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "run-cas-meta-"));
    const res = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) AS n FROM variants",
      runId: "cas-meta-run",
      store,
      author: "agent:A",
      cas,
      casMetadata: { conn: store, nowMs: 1000 },
    });
    assert.ok(res.ok);
    if (!res.ok) return;
    const digests = new Set(Object.values(res.casRefs ?? {}).filter((x): x is string => typeof x === "string").map((x) => x.slice("sha256:".length)));
    assert.ok(digests.size >= 3, "result/receipts/replay/run-object CAS refs were returned");

    const objectRows = (await store.all<{ digest: string; state: string }>(
      `SELECT digest, state FROM cas_object ORDER BY digest`,
    )).filter((r) => digests.has(r.digest));
    assert.deepEqual(new Set(objectRows.map((r) => r.digest)), digests);
    assert.deepEqual([...new Set(objectRows.map((r) => r.state))], ["committed"]);
    const refRows = await store.all<{ digest: string }>(
      `SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'run' ORDER BY digest`,
      [`run:${res.runId}`],
    );
    assert.deepEqual(new Set(refRows.map((r) => r.digest)), digests);

    const rerun = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) + 1 AS n FROM variants",
      runId: "cas-meta-run",
      store,
      author: "agent:A",
      cas,
      casMetadata: { conn: store, nowMs: 1500 },
    });
    assert.ok(rerun.ok);
    if (!rerun.ok) return;
    const rerunDigests = new Set(Object.values(rerun.casRefs ?? {}).filter((x): x is string => typeof x === "string").map((x) => x.slice("sha256:".length)));
    const replacedRefRows = await store.all<{ digest: string }>(
      `SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'run' ORDER BY digest`,
      [`run:${rerun.runId}`],
    );
    assert.deepEqual(new Set(replacedRefRows.map((r) => r.digest)), rerunDigests, "run id reuse replaces stale CAS refs with the current run's roots");

    await collectGarbage(cwd, { casMode: "shared", metadata: { conn: store, cas, cutoffMs: 2000, graceMs: 0 }, minAgeMs: 1, runs: { keep: 0 } });
    for (const digest of rerunDigests) assert.equal(await cas.has({ algorithm: "sha256", digest }), true, "run ref protects CAS bytes under metadata GC");

    await dropCasRefs(store, `run:${rerun.runId}`);
    await collectGarbage(cwd, { casMode: "shared", metadata: { conn: store, cas, cutoffMs: 2000, graceMs: 0 }, minAgeMs: 1, runs: { keep: 0 } });
    for (const digest of rerunDigests) assert.equal(await cas.has({ algorithm: "sha256", digest }), false, "dropping the run ref releases CAS bytes to metadata GC");
  });

  test("compute-produced reports and figures become ledger artifacts with shared-CAS refs", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-artifacts-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "run-artifacts-"));
    const manifest = {
      schema: "pi-bio.manifest.v1",
      id: "artifact-ledger-run",
      version: "0.1.0",
      title: "Artifact ledger run",
      description: "A files-only compute run that produces report and figure artifacts.",
      provides: {
        resolvers: [{ id: "compute.run", version: "0.1.0", title: "Compute", description: "Run a process", output: { mode: "table" } }],
        resources: [{
          id: "artifacts",
          title: "Artifacts",
          kind: "virtual",
          resolver: "compute.run",
          params: {
            table: "artifacts",
            command: ["sh", "-c", "printf '<html>ok</html>' > report.html; printf '<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>' > plot.svg"],
            resultTable: "artifacts",
            outputs: [
              { name: "report", path: "report.html", kind: "file", mediaType: "text/html", semanticRole: "report", attrs: { renderer: "shell-html" } },
              { name: "plot", path: "plot.svg", kind: "file", mediaType: "image/svg+xml", semanticRole: "figure", attrs: { renderer: "shell-svg", source_table: "none" } },
            ],
          },
        }],
      },
    };
    const manifestPath = join(cwd, "manifest.json");
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));

    const res = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath,
      sql: "SELECT name, digest, media_type, semantic_role FROM artifacts ORDER BY name",
      runId: "artifact-run",
      now: "2026-07-06T11:00:00.000Z",
      store,
      author: "agent:A",
      compute: { runner: nodeComputeRunner() },
      cas,
      casMetadata: { conn: store, nowMs: 1000 },
    });
    assert.ok(res.ok);
    if (!res.ok) return;

    const resultRows = JSON.parse(await fsp.readFile(join(res.runDir, "result.json"), "utf8")).rows as Array<{
      name: string;
      digest: string;
      media_type: string;
      semantic_role: string;
    }>;
    assert.deepEqual(resultRows.map((r) => [r.name, r.media_type, r.semantic_role]), [
      ["plot", "image/svg+xml", "figure"],
      ["report", "text/html", "report"],
    ]);
    const artifactDigests = new Set(resultRows.map((r) => r.digest.slice("sha256:".length)));

    const facts = await store.all<{ subject_id: string; media_type: string; semantic_role: string; size_bytes: bigint }>(
      `SELECT subject_id,
              json_extract_string(value_json, '$.media_type') AS media_type,
              json_extract_string(value_json, '$.semantic_role') AS semantic_role,
              CAST(json_extract_string(value_json, '$.size_bytes') AS BIGINT) AS size_bytes
       FROM bio_observations
       WHERE predicate = 'artifact'
       ORDER BY semantic_role`,
    );
    assert.deepEqual(facts.map((f) => [f.media_type, f.semantic_role]), [
      ["image/svg+xml", "figure"],
      ["text/html", "report"],
    ]);
    assert.ok(facts.every((f) => f.subject_id.startsWith("cas:sha256:") && Number(f.size_bytes) > 0));

    await materializeBioEdgesAsOf(store, MEMORY_NOW);
    const edges = await store.all<{ predicate: string; to_id: string; attrs: string }>(
      `SELECT predicate, to_id, attrs::VARCHAR AS attrs
       FROM bio_edges_as_of
       WHERE from_id = ?
       ORDER BY to_id`,
      [`run:${res.runId}`],
    );
    assert.equal(edges.length, 2);
    assert.ok(edges.every((e) => e.predicate === "produces"));
    const edgeAttrs = edges.map((e) => JSON.parse(e.attrs) as Record<string, unknown>);
    assert.deepEqual(edgeAttrs.map((a) => [a.resource_id, a.artifact_name, a.producer_run, a.source_digest === a.source_receipt_digest]), [
      ["artifacts", "plot", `run:${res.runId}`, true],
      ["artifacts", "report", `run:${res.runId}`, true],
    ]);
    assert.deepEqual(edgeAttrs.map((a) => a.plotting_system).sort(), ["shell-html", "shell-svg"]);

    const artifactRefs = await store.all<{ digest: string }>(
      `SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'artifact' ORDER BY digest`,
      [`run:${res.runId}`],
    );
    assert.deepEqual(new Set(artifactRefs.map((r) => r.digest)), artifactDigests);

    await store.run(`DELETE FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'`, [`run:${res.runId}`]);
    await collectGarbage(cwd, { casMode: "shared", metadata: { conn: store, cas, cutoffMs: 3000, graceMs: 0 }, minAgeMs: 1, runs: { keep: 0 } });
    for (const digest of artifactDigests) {
      assert.equal(await cas.has({ algorithm: "sha256", digest }), true, "artifact refs protect report/figure bytes after run-result refs are dropped");
    }

    const secondManifest = structuredClone(manifest);
    secondManifest.provides.resources[0]!.params.command = ["sh", "-c", "printf '<html>new</html>' > report.html"];
    secondManifest.provides.resources[0]!.params.outputs = [
      { name: "report", path: "report.html", kind: "file", mediaType: "text/html", semanticRole: "report", attrs: { renderer: "shell-html-v2" } },
    ];
    await fsp.writeFile(manifestPath, JSON.stringify(secondManifest));
    const rerun = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath,
      sql: "SELECT name, digest, media_type, semantic_role FROM artifacts ORDER BY name",
      runId: "artifact-run",
      now: "2026-07-06T10:00:00.000Z",
      store,
      author: "agent:A",
      compute: { runner: nodeComputeRunner() },
      cas,
      casMetadata: { conn: store, nowMs: 4000 },
    });
    assert.ok(rerun.ok);
    if (!rerun.ok) return;
    const rerunRows = JSON.parse(await fsp.readFile(join(rerun.runDir, "result.json"), "utf8")).rows as Array<{ name: string; digest: string }>;
    const rerunArtifactDigests = new Set(rerunRows.map((r) => r.digest.slice("sha256:".length)));
    assert.equal(rerunArtifactDigests.size, 1);

    await materializeBioEdgesAsOf(store, MEMORY_NOW);
    const rerunEdges = await store.all<{ to_id: string; attrs: string }>(
      `SELECT to_id, attrs::VARCHAR AS attrs
       FROM bio_edges_as_of
       WHERE from_id = ? AND predicate = 'produces'
       ORDER BY to_id`,
      [`run:${rerun.runId}`],
    );
    assert.equal(rerunEdges.length, 1, "same-runId rerun tombstones produced artifacts that are no longer declared");
    assert.equal((JSON.parse(rerunEdges[0]!.attrs) as Record<string, unknown>).artifact_name, "report");

    const rerunArtifactRefs = await store.all<{ digest: string }>(
      `SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'artifact' ORDER BY digest`,
      [`run:${rerun.runId}`],
    );
    assert.deepEqual(new Set(rerunArtifactRefs.map((r) => r.digest)), rerunArtifactDigests, "same-runId rerun replaces stale artifact roots");

    await collectGarbage(cwd, { casMode: "shared", metadata: { conn: store, cas, cutoffMs: 5000, graceMs: 0 }, minAgeMs: 1, runs: { keep: 0 } });
    for (const digest of artifactDigests) {
      if (!rerunArtifactDigests.has(digest)) assert.equal(await cas.has({ algorithm: "sha256", digest }), false, "stale artifact roots are GC-eligible after rerun replacement");
    }
    for (const digest of rerunArtifactDigests) {
      assert.equal(await cas.has({ algorithm: "sha256", digest }), true, "current run-produced artifact remains rooted");
    }
    const bridgeWarnings = await store.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM bio_observations WHERE predicate = 'artifact_bridge_warning'`,
    );
    assert.equal(Number(bridgeWarnings[0]?.n ?? 0), 0, "the happy artifact bridge path emits no warning event");
  });

  test("runId reuse without casMetadata clears prior metadata CAS refs from the run log store", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-meta-reuse-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "run-cas-meta-reuse-"));
    const first = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) AS n FROM variants",
      runId: "cas-meta-reuse",
      store,
      cas,
      casMetadata: { conn: store, nowMs: 1000 },
    });
    assert.ok(first.ok);
    const before = await store.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'`,
      [`run:${first.runId}`],
    );
    assert.ok(Number(before[0]?.n ?? 0) > 0, "the CAS-backed run rooted its metadata refs");

    const second = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) + 1 AS n FROM variants",
      runId: "cas-meta-reuse",
      store,
      cas,
    });
    assert.ok(second.ok);
    const after = await store.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'`,
      [`run:${second.runId}`],
    );
    assert.equal(Number(after[0]?.n ?? 0), 0, "CAS reuse without metadata cleared stale row roots instead of pinning old bytes");

    const reroot = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) + 2 AS n FROM variants",
      runId: "cas-meta-reuse",
      store,
      cas,
      casMetadata: { conn: store, nowMs: 2000 },
    });
    assert.ok(reroot.ok);
    const rerooted = await store.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'`,
      [`run:${reroot.runId}`],
    );
    assert.ok(Number(rerooted[0]?.n ?? 0) > 0, "the metadata-backed re-run rooted rows again");

    const third = await runBioQueryFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT count(*) + 3 AS n FROM variants",
      runId: "cas-meta-reuse",
      store,
    });
    assert.ok(third.ok);
    const final = await store.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'`,
      [`run:${third.runId}`],
    );
    assert.equal(Number(final[0]?.n ?? 0), 0, "non-CAS reuse also cleared stale row roots just like stale cas-refs.json");
  });

  test("run CAS metadata roots require the run log store as the metadata authority", async () => {
    const store = await conn();
    const metadata = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-meta-authority-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "run-cas-meta-authority-"));
    await assert.rejects(
      () => runBioQueryFromManifest({
        cwd,
        dbPath: ":memory:",
        manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"),
        sql: "SELECT count(*) AS n FROM variants",
        store,
        cas,
        casMetadata: { conn: metadata, nowMs: 1000 },
      }),
      /casMetadata\.conn must be the same SqlConn passed as store/,
    );
  });

  test("lean-mode DURABILITY: receipts/replay go to CAS BEFORE the run dir is finalized — a failed CAS put can't strand a reused runId's prior provenance", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "lean-dur-"));
    const realCas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const mp = resolve(process.cwd(), "examples/variant-counts/manifest.json");
    // run 1: NON-lean with CAS at runId "r" — writes receipts.json AND puts the bytes in CAS
    const r1 = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mp, sql: "SELECT count(*) AS n FROM variants", runId: "r", cas: realCas });
    assert.ok(r1.ok);
    assert.ok((await fsp.readdir(r1.runDir)).includes("receipts.json"), "the non-lean run wrote receipts.json");
    // run 2: SAME runId, LEAN, with a CAS that FAILS on the 2nd put (receipts, after result). Because the fix CAS-writes
    // receipts BEFORE persistRun deletes the stale receipts.json, the failed put aborts the run WITHOUT the deletion —
    // so run 1's receipts.json survives. (With the old order persistRun would have already deleted it.)
    let puts = 0;
    const faulty: CasStore = { ...realCas, put: async (a, b) => { if (++puts === 2) throw new Error("injected CAS put failure"); return realCas.put(a, b); } };
    await assert.rejects(
      () => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mp, sql: "SELECT count(*) AS n FROM variants", runId: "r", cas: faulty, serialize: false }),
      /injected CAS put failure/,
    );
    assert.ok((await fsp.readdir(r1.runDir)).includes("receipts.json"), "prior receipts.json survived — the failed lean re-run's CAS write happened BEFORE persistRun could delete it (no data-loss window)");
  });

  test("runId REUSE: a re-run WITHOUT a cas clears the prior CAS run's stale cas-refs.json (no stale GC roots / advertised refs)", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "reuse-"));
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const mp = resolve(process.cwd(), "examples/variant-counts/manifest.json");
    // run 1: WITH a cas -> writes cas-refs.json
    const r1 = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mp, sql: "SELECT count(*) AS n FROM variants", runId: "reuse", cas });
    assert.ok(r1.ok);
    assert.ok((await fsp.readdir(r1.runDir)).includes("cas-refs.json"), "the CAS run wrote cas-refs.json");
    // run 2: SAME runId, NO cas -> the stale cas-refs.json must be cleared, not left to root dead digests
    const r2 = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mp, sql: "SELECT count(*) AS n FROM variants", runId: "reuse" });
    assert.ok(r2.ok);
    assert.equal((await fsp.readdir(r2.runDir)).includes("cas-refs.json"), false, "the reused runId's non-CAS re-run cleared the prior run's stale cas-refs.json");
  });

  test("DATA-LOSS: GC roots from LIVE run:<id> ledger facts — pruning the run DIR must not strand ledger-referenced CAS bytes", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const casRoot = (cas as unknown as { pathFor: (a: { algorithm: string; digest: string }) => string }).pathFor({ algorithm: "sha256", digest: "a".repeat(64) }).replace(/\/sha256\/.*$/, "");
    const cwd = await fsp.mkdtemp(join(tmpdir(), "gc-ledger-"));
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: resolve(process.cwd(), "examples/variant-counts/manifest.json"), sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas });
    assert.ok(res.ok);
    const v = JSON.parse((await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW))!.value_json!);
    const rd = v.resultDigest.slice("sha256:".length);
    assert.equal(await cas.has({ algorithm: "sha256", digest: rd }), true);
    // prune the run DIR (keep 0) — the run:<id> ledger fact stays live and STILL references rd (files are optional
    // serialize; the fact is the durable reference). WITH the store, GC roots from that live fact -> bytes survive.
    await collectGarbage(cwd, { casRoot, runs: { keep: 0 }, minAgeMs: 0, store });
    assert.equal(await cas.has({ algorithm: "sha256", digest: rd }), true, "ledger-rooted result bytes survived GC after the run dir was pruned");
    // CONTRAST — the gap this closes: a GC WITHOUT the store roots only from the (now-gone) dir, so the still-live
    // ledger fact's bytes are stranded and swept (a later 'fetch this run's result from CAS by digest' would fail).
    await collectGarbage(cwd, { casRoot, runs: { keep: 0 }, minAgeMs: 0 });
    assert.equal(await cas.has({ algorithm: "sha256", digest: rd }), false, "without the store the ledger-referenced bytes are unrooted and swept (the gap the store-rooting closes)");
  });
});
