import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey, observationsAsOf } from "../src/duckdb/observations.js";
import { actionCacheGet, actionCachePut, actionInputDigest, recallRunResult } from "../src/hosts/action-cache.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};

describe("run-store lean mode: run.json never points at an unwritten file", () => {
  test("serialize:false — the output artifact in run.json is the CAS uri, and result.json is NOT written", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "lean-run-"));
    const res = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: join(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT 1 AS x", store, author: "agent:A", cas, serialize: false,
    });
    assert.equal(res.ok, true);
    await assert.rejects(fsp.access(join(res.runDir, "result.json")), "result.json is NOT written in lean mode");
    const run = JSON.parse(await fsp.readFile(join(res.runDir, "run.json"), "utf8"));
    const outArt = (run.artifacts ?? []).find((a: { role?: string }) => a.role === "output");
    assert.match(outArt.path, /^cas:sha256:/, "the output artifact points at CAS, not the missing result.json");
  });
});

describe("run-store BigInt serialization: lossless, no silent >2^53 corruption", () => {
  test("a BIGINT beyond 2^53 persists as a lossless decimal string; a small one stays a number", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "bigint-run-"));
    const res = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: join(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT 9223372036854775807::BIGINT AS big, 42::BIGINT AS small", store, author: "agent:A", cas,
    });
    assert.equal(res.ok, true);
    const parsed = JSON.parse(await fsp.readFile(join(res.runDir, "result.json"), "utf8"));
    const row = parsed.rows[0];
    assert.equal(row.big, "9223372036854775807", "a >2^53 value is a lossless string, not a rounded Number");
    assert.equal(row.small, 42, "a small value stays a natural JSON number");
  });
});

describe("ActionCache: input CASID -> output CASID (LLVM CAS ActionCache in the ONE store)", () => {
  const base = { kind: "query" as const, manifest: { digest: "sha256:m", snapshot: {} as never, path: "x" }, sql: "SELECT 1", resources: ["a", "b"], bindings: undefined, sourceReceiptDigests: ["sha256:s1"] };

  test("the input digest is stable, resource-order-insensitive, and sensitive to SQL/manifest", () => {
    assert.equal(actionInputDigest(base), actionInputDigest({ ...base, resources: ["b", "a"] }));
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, sql: "SELECT 2" }));
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, manifest: { ...base.manifest, digest: "sha256:other" } }));
  });

  test("content-addressed: a changed source (different sourceReceiptDigests) yields a DIFFERENT key — no stale dedup", () => {
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, sourceReceiptDigests: ["sha256:s2"] }));
  });

  test("the key is sensitive to RESULT-AFFECTING execution facts (init SQL, config, process, env) — no wrong-result serving", () => {
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, duckdbInitSqlDigest: "sha256:init" }), "init SQL (via its digest) changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, duckdbConfigDigest: "sha256:cfg" }), "config changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, process: { command: ["Rscript", "fit.R"] } }), "process changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, environment: { status: "matched", observedDigest: "sha256:e" } }), "environment changes the key");
  });

  test("put/get round-trips input -> output; a miss is null", async () => {
    const c = await conn();
    await actionCachePut(c, "sha256:in", "sha256:out", "2026-01-01T00:00:01Z", "agent:A");
    assert.equal(await actionCacheGet(c, "sha256:in"), "sha256:out");
    assert.equal(await actionCacheGet(c, "sha256:missing"), null);
  });

  test("two identical runs dedup to the same result CASID, and the ActionCache records input -> that output", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const req = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas };
    const a = await runBioQueryFromManifest({ ...req });
    const b = await runBioQueryFromManifest({ ...req });
    const digestOf = async (runId: string) => JSON.parse((await observationAsOfKey(store, `run:${runId}`, MEMORY_NOW))!.value_json!).resultDigest as string;
    const ra = await digestOf(a.runId);
    assert.equal(ra, await digestOf(b.runId)); // identical inputs -> identical result CASID (dedup)
    const cached = (await observationsAsOf(store, MEMORY_NOW)).filter((r) => r.predicate === "action_output");
    assert.ok(cached.some((r) => JSON.parse(r.value_json!).output === ra), "the ActionCache maps this input's CASID to the result CASID");
  });

  test("recallRunResult replays a recorded run's result FROM CAS by its recorded inputs — no re-execution; miss is null", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const req = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence", store, author: "agent:A", cas } as const;
    const res = await runBioQueryFromManifest({ ...req });
    assert.ok(res.ok);
    if (!res.ok) return;
    // the enriched replay (with sourceReceiptDigests) is what a caller has recorded; recall needs no re-resolution
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    const recalled = await recallRunResult(store, cas, replay);
    assert.ok(recalled, "hit: the prior run's result is recalled");
    assert.equal(recalled!.resultDigest, res.casRefs!.result);
    assert.equal(recalled!.rows.length, res.rowCount); // the actual result rows, fetched from CAS
    // a different input (different SQL) -> a miss, so the caller re-runs instead of serving something stale
    assert.equal(await recallRunResult(store, cas, { ...replay, sql: "SELECT 1" }), null);
  });
});
