import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type BioManifest } from "../src/core/manifest.js";
import type { SqlConn } from "../src/core/ports.js";
import { runOperation } from "../src/core/operations.js";
import { defineBioOperationSpec } from "../src/core/operation-spec.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbFileScanResolver } from "../src/duckdb/resolvers/duckdb-file-scan.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

// The variant record is the abstraction; the source FORMAT is a swappable provider. Here annotated_variants
// comes from a plain CSV via DuckDB-native read_csv_auto — no VCF, no extension — yet the SAME operation SQL
// produces the SAME answer as the VCF and inline providers. Swapping provider is swapping one resolver on the
// resource; the operation SQL never changes.

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

const manifest: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "rare-high-impact-variants-csv",
  version: "0.1.0",
  title: "Rare high-impact variants (CSV provider)",
  description: "Rare loss-of-function variants over a CSV variant record, abstaining on unknown frequency.",
  provides: {
    resolvers: [
      { id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a DuckDB-native file (csv/tsv/parquet/json) into a table.", output: { mode: "table" } },
      { id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize an inline table.", output: { mode: "table" } },
    ],
    resources: [
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "test/fixtures/annotated_variants.csv", table: "annotated_variants" } },
      { id: "so_loss_of_function", title: "LoF SO terms", kind: "virtual", resolver: "inline.table", params: { table: "so_loss_of_function", columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "SO:0001587" }, { id: "SO:0001575" }, { id: "SO:0001589" }] } },
    ],
    operations: [defineBioOperationSpec({
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["annotated_variants", "so_loss_of_function"] },
    })],
  },
};

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
function registry(resolver = "duckdb.file_scan", params: Record<string, unknown> = { path: "test/fixtures/annotated_variants.csv", table: "annotated_variants" }) {
  const r = createBioRegistry();
  r.registerManifest({ ...manifest, provides: { ...manifest.provides, resources: [{ ...manifest.provides.resources![0]!, resolver, params }, manifest.provides.resources![1]!] } });
  r.bindResolverImpl("duckdb.file_scan", duckdbFileScanResolver);
  r.bindResolverImpl("inline.table", inlineTableResolver);
  return r;
}
const run = (r: ReturnType<typeof createBioRegistry>, conn: SqlConn) =>
  runOperation(r, conn, { operationId: "rare_high_impact.report", resources: ["annotated_variants", "so_loss_of_function"], runId: "csv-run-1", now: "2026-06-28T00:00:00Z" });
const bucketCount = (rows: Array<Record<string, unknown>>, bucket: string) =>
  Number((rows.find((r) => r.bucket === bucket)?.n as number | undefined) ?? 0);

describe("duckdb.file_scan: variant record from a non-VCF provider", () => {
  test("a CSV provider yields the same answer as VCF/inline — format is swappable", async () => {
    const { result, receipts } = await run(registry(), await memoryConn());
    assert.equal(bucketCount(result.rows, "included"), 1);
    assert.equal(bucketCount(result.rows, "no_frequency"), 1); // empty CSV cell -> NULL -> abstained
    assert.equal(bucketCount(result.rows, "benign"), 1);
    const receipt = receipts.find((x) => x.resourceId === "annotated_variants")!;
    assert.equal(receipt.resolverId, "duckdb.file_scan");
    assert.ok(receipt.sourceSnapshots.some((s) => s.source === "duckdb.read_csv_auto"));
    assert.ok(receipt.sourceSnapshots.some((s) => /^sha256:/.test(s.version ?? "")));
  });

  test("re-resolving on the same connection is idempotent (CREATE OR REPLACE)", async () => {
    const conn = await memoryConn();
    const r = registry();
    await r.resolveResource("annotated_variants", { conn, now: "2026-06-28T00:00:00Z" });
    await assert.doesNotReject(() => r.resolveResource("annotated_variants", { conn, now: "2026-06-28T00:00:00Z" }));
    // the whole operation also re-runs cleanly on a reused connection
    await assert.doesNotReject(() => run(r, conn));
  });

  test("fails closed on a missing path, a bad reader, and an undetectable extension", async () => {
    const c1 = await memoryConn();
    await assert.rejects(() => run(registry("duckdb.file_scan", { table: "annotated_variants" }), c1), /'path' \(string\) is required/);
    const c2 = await memoryConn();
    await assert.rejects(() => run(registry("duckdb.file_scan", { path: "x.csv", reader: "exe", table: "annotated_variants" }), c2), /unknown reader 'exe'/);
    const c3 = await memoryConn();
    await assert.rejects(() => run(registry("duckdb.file_scan", { path: "test/fixtures/no_ext_file", table: "annotated_variants" }), c3), /cannot infer a reader/);
  });
});
