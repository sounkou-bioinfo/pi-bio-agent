import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type SqlConn } from "../src/core/manifest.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { rareHighImpactManifest, rareHighImpactResolverImpl, runRareHighImpact } from "../src/packs/rare-high-impact-variants.js";

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("flagship: rare high-impact variants (manifest #1)", () => {
  test("a manifest registers specs only — the snapshot carries no implementation", () => {
    const registry = createBioRegistry();
    registry.registerManifest(rareHighImpactManifest);
    registry.bindResolverImpl("fixture.annotated_variants", rareHighImpactResolverImpl);

    const snap = registry.snapshot();
    assert.equal(snap.resolvers[0]?.id, "fixture.annotated_variants");
    assert.equal(snap.operations[0]?.id, "rare_high_impact.report");
    assert.equal(snap.termSets[0]?.id, "so.loss_of_function");
    // the bound impl never leaks into the snapshot: it round-trips through JSON unchanged (pure data)
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  test("resolution fails closed: unknown spec, and declared-but-unbound", async () => {
    const conn = await memoryConn();
    const registry = createBioRegistry();
    registry.registerManifest(rareHighImpactManifest);
    await assert.rejects(() => registry.resolve("nope.missing", {}, { conn }), /no resolver spec/);
    await assert.rejects(() => registry.resolve("fixture.annotated_variants", {}, { conn }), /no implementation is bound/);
    assert.throws(() => registry.bindResolverImpl("nope.missing", rareHighImpactResolverImpl), /no resolver spec/);
  });

  test("the fixture resolver materializes annotated_variants and returns a timed receipt", async () => {
    const conn = await memoryConn();
    const registry = createBioRegistry();
    registry.registerManifest(rareHighImpactManifest);
    registry.bindResolverImpl("fixture.annotated_variants", rareHighImpactResolverImpl);

    const receipt = await registry.resolve("fixture.annotated_variants", {}, { conn, now: "2026-06-28T00:00:00Z" });
    assert.equal(receipt.schema, "pi-bio.resolution_receipt.v1");
    assert.equal(receipt.resolverId, "fixture.annotated_variants");
    assert.equal(receipt.result.name, "annotated_variants");
    assert.deepEqual(receipt.sourceSnapshots, [{ source: "synthetic-fixture", version: "0.1.0", retrievedAt: "2026-06-28T00:00:00Z" }]);
    const [{ n }] = await conn.all<{ n: number }>("SELECT count(*) AS n FROM annotated_variants");
    assert.equal(Number(n), 4);
  });

  test("the operation SQL abstains: excludes no-frequency, benign, and not-high-impact; counts partition", async () => {
    const conn = await memoryConn();
    const registry = createBioRegistry();
    registry.registerManifest(rareHighImpactManifest);
    registry.bindResolverImpl("fixture.annotated_variants", rareHighImpactResolverImpl);

    const { report } = await runRareHighImpact(registry, conn, { runId: "flagship-run-1", now: "2026-06-28T00:00:00Z" });
    assert.deepEqual(report.counts, {
      totalVariants: 4,
      includedRareHighImpact: 1,
      excludedNoFrequency: 1,
      excludedNotHighImpact: 1,
      excludedBenign: 1,
    });
    // the buckets partition the input — nothing falls through
    const sum = Object.values(report.counts).reduce((a, b) => a + b, 0) - report.counts.totalVariants;
    assert.equal(sum, report.counts.totalVariants);
    assert.deepEqual(report.included.map((i) => i.variantKey), ["1:100:A:T"]);
    assert.ok(report.excluded.some((e) => e.variantKey === "1:200:C:G" && e.reason === "no_frequency"));
  });

  test("the report JSON is stable and uses no diagnosis/actionability language", async () => {
    const conn1 = await memoryConn();
    const conn2 = await memoryConn();
    const make = async (conn: SqlConn) => {
      const r = createBioRegistry();
      r.registerManifest(rareHighImpactManifest);
      r.bindResolverImpl("fixture.annotated_variants", rareHighImpactResolverImpl);
      return (await runRareHighImpact(r, conn, { runId: "flagship-run-1", now: "2026-06-28T00:00:00Z" })).report;
    };
    const a = await make(conn1);
    const b = await make(conn2);
    assert.deepEqual(a, b);
    assert.ok(a.caveats.length >= 1);
    assert.doesNotMatch(JSON.stringify(a).toLowerCase(), /diagnos|treat|prescrib|you should|recommend/);
  });

  test("the run record links operation + resolver receipt to a report artifact", async () => {
    const conn = await memoryConn();
    const registry = createBioRegistry();
    registry.registerManifest(rareHighImpactManifest);
    registry.bindResolverImpl("fixture.annotated_variants", rareHighImpactResolverImpl);

    const { run } = await runRareHighImpact(registry, conn, { runId: "flagship-run-1", now: "2026-06-28T00:00:00Z" });
    assert.equal(run.status, "succeeded");
    assert.deepEqual(run.events.map((e) => e.type), ["created", "started", "artifact", "completed"]);
    const artifact = run.artifacts?.[0];
    assert.ok(artifact && artifact.role === "report" && artifact.path.includes("flagship-run-1"));
    const sources = (artifact.provenance ?? []).map((p) => p.source);
    assert.ok(sources.includes("rare_high_impact.report"), "provenance references the operation");
    assert.ok(sources.some((s) => s.startsWith("fixture.annotated_variants@")), "provenance references the resolver receipt");
  });
});
