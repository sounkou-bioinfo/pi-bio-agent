import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type BioManifest } from "../src/core/manifest.js";
import type { SqlConn } from "../src/core/ports.js";
import { runOperation } from "../src/core/operations.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";
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
  { variant_key: "5:5000:G:C", consequence: "SO:0001587", allele_frequency: 0.0001, clinical_significance: "Benign" }, // rare LoF but Benign -> excluded (safety)
];

// The operation returns the ANSWER (counts per bucket), in SQL — no TypeScript reducer. result.json IS the
// report. This is plain SQL the agent could have written after a DESCRIBE.
const RARE_HIGH_IMPACT_SQL = [
  "WITH classified AS (",
  "  SELECT variant_key,",
  "    CASE",
  "      WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_high_impact'",
  "      WHEN clinical_significance = 'Benign' THEN 'benign'",
  "      WHEN allele_frequency >= 0.01 THEN 'not_rare'",
  "      ELSE 'included'",
  "    END AS bucket",
  "  FROM annotated_variants",
  ")",
  "SELECT bucket, CAST(count(*) AS INTEGER) AS n FROM classified GROUP BY bucket ORDER BY bucket",
].join("\n");

// The whole "skill" is this manifest — pure data. No code is question-specific.
const flagshipManifest: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "rare-high-impact-variants",
  version: "0.1.0",
  title: "Rare high-impact variants",
  description: "Count frequency-known rare loss-of-function variants, abstaining on unknown frequency.",
  provides: {
    resources: [
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "inline.table", params: { table: "annotated_variants", columns: [{ name: "variant_key", type: "TEXT" }, { name: "consequence", type: "TEXT" }, { name: "allele_frequency", type: "DOUBLE" }, { name: "clinical_significance", type: "TEXT" }], rows: ANNOTATED_VARIANTS } },
      { id: "so_loss_of_function", title: "Loss-of-function SO terms", kind: "virtual", resolver: "inline.table", params: { table: "so_loss_of_function", columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "SO:0001587" }, { id: "SO:0001575" }, { id: "SO:0001589" }] } },
    ],
    resolvers: [{ id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize a declared inline table.", output: { mode: "table" } }],
    operations: [defineBioOperationSpec({
      id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["annotated_variants", "so_loss_of_function"] },
      notes: [
        "Variants with unknown allele frequency are abstained from, not counted as rare.",
        "Benign-annotated variants are excluded regardless of frequency or consequence.",
      ],
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
  // resources omitted on purpose — the runner derives them from the operation's requiredResources
  runOperation(registry, conn, { operationId: "rare_high_impact.report", runId: "flagship-run-1", now: "2026-06-28T00:00:00Z" });
// the operation's SQL already returned per-bucket counts; just index them
const bucketCount = (rows: Array<Record<string, unknown>>, bucket: string) =>
  Number((rows.find((r) => r.bucket === bucket)?.n as number | undefined) ?? 0);

describe("flagship: rare high-impact variants (data over generic primitives)", () => {
  test("the manifest registers specs only — the snapshot is pure data (no impl leaks)", () => {
    const snap = freshRegistry().snapshot();
    assert.equal(snap.operations[0]?.id, "rare_high_impact.report");
    assert.equal(snap.resources.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  test("resolution fails closed: incomplete list, unknown resource, and declared-but-unbound resolver", async () => {
    const conn = await memoryConn();
    const r = createBioRegistry();
    r.registerManifest(flagshipManifest); // no impl bound
    const op = (resources?: string[]) => runOperation(r, conn, { operationId: "rare_high_impact.report", resources, runId: "x", now: "t" });
    // an explicit list must cover the operation's declared requiredResources
    await assert.rejects(() => op(["annotated_variants"]), /do not cover required resource\(s\): so_loss_of_function/);
    // an explicit resource that isn't registered fails closed
    await assert.rejects(() => op(["nope", "annotated_variants", "so_loss_of_function"]), /unregistered resource 'nope'/);
    // with resources derived from requiredResources, an unbound resolver fails closed
    await assert.rejects(() => op(), /no implementation is bound/);
  });

  test("the operation's SQL returns the answer: ClawBio rhi_01 (included = 1), no-frequency abstained, benign excluded", async () => {
    const { result } = await runFlagship(freshRegistry(), await memoryConn());
    assert.equal(bucketCount(result.rows, "included"), 1); // ClawBio rhi_01 ground-truth count
    assert.equal(bucketCount(result.rows, "no_frequency"), 1); // abstention: unknown frequency is NOT counted as rare
    assert.equal(bucketCount(result.rows, "not_rare"), 1); // common splice_donor
    assert.equal(bucketCount(result.rows, "not_high_impact"), 1); // rare missense
    assert.equal(bucketCount(result.rows, "benign"), 1); // rare LoF but Benign -> excluded (safety thesis)
    assert.equal(result.rows.reduce((a, r) => a + Number(r.n), 0), 5); // all five variants partitioned
  });

  test("safety caveats are operation data (notes), not a code-computed report", () => {
    const op = freshRegistry().getOperation("rare_high_impact.report");
    assert.equal(op?.notes?.length, 2); // caveats travel with the operation as manifest data
  });

  test("safety gate: the flagship carries no diagnosis / clinical-recommendation framing", () => {
    // A headline gate (roadmap §2): a run must never frame its answer as diagnosis or clinical advice. The
    // only natural-language surface that travels with a run is the manifest/operation prose (title,
    // description, notes) — the result itself is bucket counts. Assert that prose stays classificatory and
    // abstaining, never clinical-directive. (A flagship safety-framing assertion, not a core validator —
    // policing prose in the runner would be bio-logic in code; here it guards the canonical example.)
    const r = freshRegistry();
    const op = r.getOperation("rare_high_impact.report")!;
    const snap = r.snapshot();
    const prose = [snap.manifests[0]?.title, flagshipManifest.description, op.title, op.description, ...(op.notes ?? [])].join("\n").toLowerCase();
    const clinicalFraming = /\b(diagnos\w*|prescrib\w*|treatment|disease-causing|medical advice|actionable variant|you (?:have|should|are at|may have)|consult (?:a|your) (?:doctor|physician|clinician|provider)|risk of (?:disease|cancer))\b/;
    assert.ok(!clinicalFraming.test(prose), `flagship prose must not carry clinical framing, found in: ${prose}`);
    // present, not merely absent-of-harm: the abstention caveat (the safety thesis) actually rides along
    assert.ok(op.notes?.some((n) => /abstain|unknown allele frequency/i.test(n)), "the abstention caveat must be present in operation notes");
  });

  test("the result + report are stable and the run links operation + resolver receipts", async () => {
    const a = await runFlagship(freshRegistry(), await memoryConn());
    const b = await runFlagship(freshRegistry(), await memoryConn());
    assert.deepEqual(a.result, b.result);
    assert.equal(a.run.status, "succeeded");
    assert.deepEqual(a.run.events.map((e) => e.type), ["created", "started", "artifact", "completed"]);
    const provenance = a.run.artifacts?.[0]?.provenance ?? [];
    const sources = provenance.map((p) => p.source);
    assert.ok(sources.includes("rare_high_impact.report"));
    assert.ok(sources.some((s) => s.startsWith("inline.table@")));
    assert.equal(a.receipts.length, 2);
    // reproducibility pin: the operation provenance carries the version + a digest of the exact SQL that ran
    const opProv = provenance.find((p) => p.source === "rare_high_impact.report")!;
    assert.equal(opProv.version, "0.1.0");
    assert.match(opProv.digest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(a.run.artifacts?.[0]?.provenance?.[0]?.digest, b.run.artifacts?.[0]?.provenance?.[0]?.digest); // stable across runs
  });
});
