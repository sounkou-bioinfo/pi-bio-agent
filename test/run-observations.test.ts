import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRunObservation } from "../src/hosts/run-observations.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
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
    // only run.json on disk — no result.json / receipts.json / replay.json
    assert.deepEqual((await fsp.readdir(res.runDir)).sort(), ["run.json"]);
    assert.ok(res.casRefs && res.casRefs.result && res.casRefs.receipts && res.casRefs.replay);
    for (const ref of [res.casRefs.result, res.casRefs.receipts, res.casRefs.replay]) {
      assert.match(ref!, /^sha256:[a-f0-9]{64}$/);
      assert.equal(await cas.has({ algorithm: "sha256", digest: ref!.slice(7) }), true); // bytes are in CAS
    }
    const v = JSON.parse((await observationAsOfKey(store, `run:${res.runId}`, MEMORY_NOW))!.value_json!);
    assert.equal(v.receiptsDigest, res.casRefs.receipts); // the run fact references receipts + replay by digest
    assert.equal(v.replayDigest, res.casRefs.replay);
  });
});
