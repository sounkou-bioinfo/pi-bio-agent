import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey, observationsAsOf } from "../src/duckdb/observations.js";
import { actionCacheGet, actionCachePut, actionInputDigest } from "../src/hosts/action-cache.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};

describe("ActionCache: input CASID -> output CASID (LLVM CAS ActionCache in the ONE store)", () => {
  const base = { kind: "query" as const, manifest: { digest: "sha256:m", snapshot: {} as never, path: "x" }, sql: "SELECT 1", resources: ["a", "b"], bindings: undefined };

  test("the input digest is stable, resource-order-insensitive, and sensitive to the SQL", () => {
    assert.equal(actionInputDigest(base), actionInputDigest({ ...base, resources: ["b", "a"] }));
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, sql: "SELECT 2" }));
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, manifest: { ...base.manifest, digest: "sha256:other" } }));
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
});
