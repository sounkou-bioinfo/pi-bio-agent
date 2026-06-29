import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type DomainPackManifest } from "../src/core/manifest.js";
import type { SqlConn } from "../src/core/ports.js";
import { runOperation } from "../src/core/operations.js";
import { defineBioOperationSpec } from "../src/core/operation-spec.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckhtsReadBcfResolver } from "../src/duckdb/resolvers/duckhts-read-bcf.js";
import { describeTable } from "../src/core/schema-discovery.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

const VCF = "test/fixtures/rare_high_impact.vcf";

// duckhts is provisioned by the HOST, never the default suite (no ambient INSTALL/network). We only LOAD an
// already-installed extension and skip cleanly when absent. Provision locally: `npm run provision:duckhts`.
const duckhtsAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:")).connect();
    await c.run("LOAD duckhts;");
    return true;
  } catch {
    return false;
  }
})();

// The resolver is a GENERIC raw reader (SELECT * FROM read_bcf). The VCF dialect mapping (INFO_MC ->
// consequence, etc.) lives HERE, in the operation's SQL as manifest data — not in resolver TypeScript.
// A new annotated-VCF dialect is a new projection in this SQL, never an edit to duckhts.read_bcf.
const RARE_HIGH_IMPACT_SQL = [
  "WITH annotated AS (",
  "  SELECT CHROM || ':' || POS || ':' || REF || ':' || ALT[1] AS variant_key,",
  "         INFO_MC[1]     AS consequence,",
  "         INFO_AF[1]     AS allele_frequency,",
  "         INFO_CLNSIG[1] AS clinical_significance",
  "  FROM vcf_raw",
  "),",
  "classified AS (",
  "  SELECT variant_key,",
  "    CASE",
  "      WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_high_impact'",
  "      WHEN clinical_significance = 'Benign' THEN 'benign'",
  "      WHEN allele_frequency >= 0.01 THEN 'not_rare'",
  "      ELSE 'included'",
  "    END AS bucket",
  "  FROM annotated",
  ")",
  "SELECT bucket, CAST(count(*) AS INTEGER) AS n FROM classified GROUP BY bucket ORDER BY bucket",
].join("\n");

const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1",
  id: "rare-high-impact-variants-vcf",
  version: "0.1.0",
  title: "Rare high-impact variants (real VCF)",
  description: "Rare loss-of-function variants over a real VCF: generic read_bcf + mapping in SQL.",
  domains: ["genomics"],
  provides: {
    resolvers: [
      { id: "duckhts.read_bcf", version: "0.1.0", title: "duckhts read_bcf", description: "Read a VCF/BCF into a raw table via duckhts.", output: { mode: "table" }, temporal: { kind: "snapshot", source: "vcf" } },
      { id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize an inline table.", output: { mode: "table" } },
    ],
    resources: [
      { id: "vcf_raw", title: "Raw VCF records", kind: "virtual", resolver: "duckhts.read_bcf", params: { path: VCF, table: "vcf_raw" } },
      { id: "so_loss_of_function", title: "LoF SO terms", kind: "virtual", resolver: "inline.table", params: { table: "so_loss_of_function", columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "SO:0001587" }, { id: "SO:0001575" }, { id: "SO:0001589" }] } },
    ],
    operations: [defineBioOperationSpec({
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Map raw VCF INFO fields, then classify.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["vcf_raw", "so_loss_of_function"] },
    })],
  },
};

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
function registry(rawParams?: Record<string, unknown>) {
  const r = createBioRegistry();
  const m: DomainPackManifest = rawParams
    ? { ...manifest, provides: { ...manifest.provides, resources: [{ ...manifest.provides.resources![0]!, params: rawParams }, manifest.provides.resources![1]!] } }
    : manifest;
  r.registerManifest(m);
  r.bindResolverImpl("duckhts.read_bcf", duckhtsReadBcfResolver);
  r.bindResolverImpl("inline.table", inlineTableResolver);
  return r;
}
const run = (r: ReturnType<typeof createBioRegistry>, conn: SqlConn) =>
  runOperation(r, conn, { operationId: "rare_high_impact.report", resources: ["vcf_raw", "so_loss_of_function"], runId: "vcf-run-1", now: "2026-06-28T00:00:00Z" });
const bucketCount = (rows: Array<Record<string, unknown>>, bucket: string) =>
  Number((rows.find((r) => r.bucket === bucket)?.n as number | undefined) ?? 0);

describe("duckhts.read_bcf: generic raw reader, mapping in SQL", { skip: duckhtsAvailable ? false : "duckhts unavailable (offline)" }, () => {
  test("the resolver materializes raw VCF columns; the operation SQL maps + classifies", async () => {
    const conn = await memoryConn();
    const { result, receipts } = await run(registry(), conn);

    // the resolver produced a RAW table — INFO fields intact, no canonical mapping baked in
    const rawCols = (await describeTable(conn, "vcf_raw")).map((c) => c.name);
    assert.ok(["CHROM", "POS", "REF", "ALT", "INFO_MC", "INFO_AF", "INFO_CLNSIG"].every((c) => rawCols.includes(c)));
    assert.ok(!rawCols.includes("consequence")); // the canonical name only exists after the SQL mapping

    assert.equal(bucketCount(result.rows, "included"), 1); // ClawBio rhi_01 ground truth, from a real VCF mapped in SQL
    assert.equal(bucketCount(result.rows, "no_frequency"), 1); // abstention preserved
    assert.equal(bucketCount(result.rows, "benign"), 1); // benign exclusion preserved

    const vcfReceipt = receipts.find((x) => x.resourceId === "vcf_raw")!;
    assert.equal(vcfReceipt.resolverId, "duckhts.read_bcf");
    assert.match(vcfReceipt.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(vcfReceipt.sourceSnapshots.some((s) => s.source === "duckhts"));
    assert.ok(vcfReceipt.sourceSnapshots.some((s) => s.source === `file:${VCF}` && /^sha256:/.test(s.version ?? "")));
  });

  test("fails closed on a missing path param and a nonexistent VCF file", async () => {
    const c1 = await memoryConn();
    await assert.rejects(() => run(registry({ table: "vcf_raw" }), c1), /'path' \(string\) is required/);
    const c2 = await memoryConn();
    await assert.rejects(() => run(registry({ path: "test/fixtures/does_not_exist.vcf", table: "vcf_raw" }), c2), /open|VCF|BCF|No such file/i);
  });
});
