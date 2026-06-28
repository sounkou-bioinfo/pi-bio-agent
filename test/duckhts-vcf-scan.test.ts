import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type DomainPackManifest, type SqlConn } from "../src/core/manifest.js";
import { runOperation } from "../src/core/operations.js";
import { defineBioOperationSpec } from "../src/core/operation-spec.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckhtsVcfScanResolver } from "../src/duckdb/resolvers/duckhts-vcf-scan.js";
import { describeTable } from "../src/core/schema-discovery.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

const VCF = "test/fixtures/rare_high_impact.vcf";

// duckhts is a community extension provisioned by the HOST, never by the default test suite (no ambient
// INSTALL / network). We only LOAD an already-installed extension and skip cleanly when it is absent.
// To provision it for this test locally: `npm run provision:duckhts`.
const duckhtsAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:")).connect();
    await c.run("LOAD duckhts;");
    return true;
  } catch {
    return false;
  }
})();

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

// Same flagship manifest, but annotated_variants now comes from a REAL VCF via duckhts.vcf_scan — the inline
// fixture is replaced by the real resolver, and the same generic runner + bucketed report consume it.
const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1",
  id: "rare-high-impact-variants-vcf",
  version: "0.1.0",
  title: "Rare high-impact variants (real VCF)",
  description: "Rare loss-of-function variants over a real annotated VCF, abstaining on unknown frequency.",
  domains: ["genomics"],
  provides: {
    resolvers: [
      { id: "duckhts.vcf_scan", version: "0.1.0", title: "duckhts VCF scan", description: "Read an annotated VCF/BCF into a stable table via duckhts.", output: { mode: "table" }, temporal: { kind: "snapshot", source: "vcf" } },
      { id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize an inline table.", output: { mode: "table" } },
    ],
    resources: [
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "duckhts.vcf_scan", params: { path: VCF, table: "annotated_variants" } },
      { id: "so_loss_of_function", title: "LoF SO terms", kind: "virtual", resolver: "inline.table", params: { table: "so_loss_of_function", columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "SO:0001587" }, { id: "SO:0001575" }, { id: "SO:0001589" }] } },
    ],
    operations: [defineBioOperationSpec({
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["annotated_variants", "so_loss_of_function"], requiredColumns: ["variant_key", "consequence", "allele_frequency", "clinical_significance"] },
      report: { kind: "bucketed_rows", idColumn: "variant_key", bucketColumn: "bucket", includedBucket: "included", caveats: ["Unknown frequency is abstained, not counted as rare.", "Benign variants are excluded."] },
    })],
  },
};

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
function registry(resolverParams?: Record<string, unknown>) {
  const r = createBioRegistry();
  const m: DomainPackManifest = resolverParams
    ? { ...manifest, provides: { ...manifest.provides, resources: [{ ...manifest.provides.resources![0]!, params: resolverParams }, manifest.provides.resources![1]!] } }
    : manifest;
  r.registerManifest(m);
  r.bindResolverImpl("duckhts.vcf_scan", duckhtsVcfScanResolver);
  r.bindResolverImpl("inline.table", inlineTableResolver);
  return r;
}
const run = (r: ReturnType<typeof createBioRegistry>, conn: SqlConn) =>
  runOperation(r, conn, { operationId: "rare_high_impact.report", resources: ["annotated_variants", "so_loss_of_function"], runId: "vcf-run-1", now: "2026-06-28T00:00:00Z" });

describe("duckhts.vcf_scan: first real resolver over a real VCF", { skip: duckhtsAvailable ? false : "duckhts unavailable (offline)" }, () => {
  test("the real VCF resolver yields the same bucketed answer as the inline fixture", async () => {
    const conn = await memoryConn();
    const { report, receipts } = await run(registry(), conn);
    // schema discovery on the VCF provider's output — no pre-declared variant table type
    const cols = (await describeTable(conn, "annotated_variants")).map((c) => c.name);
    assert.ok(["variant_key", "consequence", "allele_frequency", "clinical_significance"].every((c) => cols.includes(c)));
    assert.ok(report);
    assert.equal(report.included, 1); // ClawBio rhi_01 ground-truth count, now from a real VCF
    assert.equal(report.countsByBucket.no_frequency, 1); // abstention preserved
    assert.equal(report.countsByBucket.benign, 1); // benign exclusion preserved
    assert.equal(report.excluded, 4);
    // the resolver receipt is registry-stamped and pins the real source
    const vcfReceipt = receipts.find((x) => x.resourceId === "annotated_variants")!;
    assert.equal(vcfReceipt.resolverId, "duckhts.vcf_scan");
    assert.match(vcfReceipt.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(vcfReceipt.sourceSnapshots.some((s) => s.source === "duckhts"));
    assert.ok(vcfReceipt.sourceSnapshots.some((s) => s.source === `file:${VCF}` && /^sha256:/.test(s.version ?? "")));
  });

  test("fails closed on a missing path param and a nonexistent VCF file", async () => {
    const c1 = await memoryConn();
    await assert.rejects(() => run(registry({ table: "annotated_variants" }), c1), /'path' \(string\) is required/);
    const c2 = await memoryConn();
    await assert.rejects(() => run(registry({ path: "test/fixtures/does_not_exist.vcf", table: "annotated_variants" }), c2), /open|VCF|BCF|No such file/i);
  });
});
