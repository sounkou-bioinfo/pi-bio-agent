import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recordRunObservation } from "../src/hosts/run-observations.js";
import { runBioQueryFromManifest, runBioOperationFromManifest, markRunDbOpenError, isRunDbOpenError } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { CasStore } from "../src/core/cas.js";
import { collectGarbage } from "../src/hosts/gc.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";

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
