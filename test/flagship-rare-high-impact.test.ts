import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type DomainPackManifest, type SqlConn } from "../src/core/manifest.js";
import { inlineTableResolver, runOperation } from "../src/core/operations.js";
import { defineBioOperationSpec } from "../src/core/operation-spec.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

// "Rare high-impact variants" expressed as DATA over generic primitives — the substrate ships no
// question-specific module. Fixture and ground truth are ClawBio's own rhi_01 bench case (3 variants,
// count = 1) plus one no-frequency variant to exercise the abstention from the originating thread.

const ANNOTATED_VARIANTS = [
  { variant_key: "1:1000:C:T", consequence: "SO:0001587", allele_frequency: 0.0003, clinical_significance: null }, // nonsense, rare LoF -> included (rhi_01)
  { variant_key: "2:2000:G:A", consequence: "SO:0001575", allele_frequency: 0.3, clinical_significance: null }, // splice_donor, high-impact but common -> not_rare (rhi_01)
  { variant_key: "3:3000:A:G", consequence: "SO:0001583", allele_frequency: 0.0002, clinical_significance: null }, // missense, rare but not LoF -> not_high_impact (rhi_01)
  { variant_key: "4:4000:T:C", consequence: "SO:0001587", allele_frequency: null, clinical_significance: null }, // LoF, no frequency -> abstain
];

const RARE_HIGH_IMPACT_SQL = [
  "SELECT variant_key, consequence, allele_frequency,",
  "  CASE",
  "    WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "    WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_high_impact'",
  "    WHEN clinical_significance = 'Benign' THEN 'benign'",
  "    WHEN allele_frequency >= 0.01 THEN 'not_rare'",
  "    ELSE 'included'",
  "  END AS bucket",
  "FROM annotated_variants ORDER BY variant_key",
].join("\n");

// The whole "skill" is this manifest — pure data. No code is question-specific.
const flagshipManifest: DomainPackManifest = {
  id: "rare-high-impact-variants",
  version: "0.1.0",
  title: "Rare high-impact variants",
  description: "Count frequency-known rare loss-of-function variants, abstaining on unknown frequency.",
  domains: ["genomics"],
  provides: {
    resources: [
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "inline.table", params: { table: "annotated_variants", columns: [{ name: "variant_key", type: "TEXT" }, { name: "consequence", type: "TEXT" }, { name: "allele_frequency", type: "DOUBLE" }, { name: "clinical_significance", type: "TEXT" }], rows: ANNOTATED_VARIANTS } },
      { id: "so_loss_of_function", title: "Loss-of-function SO terms", kind: "virtual", resolver: "inline.table", params: { table: "so_loss_of_function", columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "SO:0001587" }, { id: "SO:0001575" }, { id: "SO:0001589" }] } },
    ],
    resolvers: [{ id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize a declared inline table.", output: { mode: "table" } }],
    operations: [defineBioOperationSpec({
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredViews: ["annotated_variants", "so_loss_of_function"] },
    })],
  },
};

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
function freshRegistry() {
  const r = createBioRegistry();
  r.registerManifest(flagshipManifest);
  r.bindResolverImpl("inline.table", inlineTableResolver);
  return r;
}
const runFlagship = (registry: ReturnType<typeof createBioRegistry>, conn: SqlConn) =>
  runOperation(registry, conn, { operationId: "rare_high_impact.report", resources: ["annotated_variants", "so_loss_of_function"], runId: "flagship-run-1", now: "2026-06-28T00:00:00Z" });
const countBuckets = (rows: Array<Record<string, unknown>>) =>
  rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [String(r.bucket)]: (acc[String(r.bucket)] ?? 0) + 1 }), {});

describe("flagship: rare high-impact variants (data over generic primitives)", () => {
  test("the manifest registers specs only — the snapshot is pure data (no impl leaks)", () => {
    const snap = freshRegistry().snapshot();
    assert.equal(snap.operations[0]?.id, "rare_high_impact.report");
    assert.equal(snap.resources.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  test("resolution fails closed: unknown resource, and declared-but-unbound resolver", async () => {
    const conn = await memoryConn();
    const r = createBioRegistry();
    r.registerManifest(flagshipManifest); // no impl bound
    await assert.rejects(() => runOperation(r, conn, { operationId: "rare_high_impact.report", resources: ["nope"], runId: "x", now: "t" }), /unregistered resource/);
    await assert.rejects(() => runOperation(r, conn, { operationId: "rare_high_impact.report", resources: ["annotated_variants"], runId: "x", now: "t" }), /no implementation is bound/);
  });

  test("the operation abstains: matches ClawBio rhi_01 (included = 1) and excludes the no-frequency variant", async () => {
    const { result } = await runFlagship(freshRegistry(), await memoryConn());
    const counts = countBuckets(result.rows);
    assert.equal(counts.included, 1); // ClawBio rhi_01 ground-truth count
    assert.equal(counts.no_frequency, 1); // abstention: unknown frequency is NOT counted as rare
    assert.equal(counts.not_rare, 1); // common splice_donor
    assert.equal(counts.not_high_impact, 1); // rare missense
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), result.rows.length); // buckets partition
    assert.equal(result.rows.find((r) => r.bucket === "included")?.variant_key, "1:1000:C:T");
  });

  test("the result is stable and links operation + resolver receipts in a run record", async () => {
    const a = await runFlagship(freshRegistry(), await memoryConn());
    const b = await runFlagship(freshRegistry(), await memoryConn());
    assert.deepEqual(a.result, b.result);
    assert.equal(a.run.status, "succeeded");
    assert.deepEqual(a.run.events.map((e) => e.type), ["created", "started", "artifact", "completed"]);
    const sources = (a.run.artifacts?.[0]?.provenance ?? []).map((p) => p.source);
    assert.ok(sources.includes("rare_high_impact.report"));
    assert.ok(sources.some((s) => s.startsWith("inline.table@")));
    assert.equal(a.receipts.length, 2);
  });
});
