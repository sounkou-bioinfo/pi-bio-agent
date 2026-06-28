import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { assertTableMatchesView, createBioRegistry, type DomainPackManifest, type SqlConn } from "../src/core/index.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbFileScanResolver } from "../src/duckdb/resolvers/duckdb-file-scan.js";
import { ANNOTATED_VARIANTS_V1 } from "../src/duckdb/resolvers/variant-record.js";

// The variant record contract is the interchange point: every provider must materialize annotated_variants.v1
// before any operation runs. Here the CSV provider (always available, no extension) is checked against it.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1",
  id: "variant-record-contract",
  version: "0.1.0",
  title: "Variant record contract check",
  description: "Materialize annotated_variants from a CSV provider and check the record contract.",
  domains: ["genomics"],
  provides: {
    resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a DuckDB-native file into a table.", output: { mode: "table" } }],
    resources: [{ id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "test/fixtures/annotated_variants.csv", table: "annotated_variants" } }],
    views: [ANNOTATED_VARIANTS_V1],
  },
};

describe("variant record contract: annotated_variants.v1", () => {
  test("the CSV provider materializes a table satisfying the contract", async () => {
    const r = createBioRegistry();
    r.registerManifest(manifest);
    r.bindResolverImpl("duckdb.file_scan", duckdbFileScanResolver);
    const conn = await memoryConn();
    await r.resolveResource("annotated_variants", { conn, now: "2026-06-28T00:00:00Z" });
    await assert.doesNotReject(() => assertTableMatchesView(conn, "annotated_variants", ANNOTATED_VARIANTS_V1));
  });

  test("the contract is registered as a view in the manifest (declared, not just asserted)", () => {
    const r = createBioRegistry();
    r.registerManifest(manifest);
    assert.equal(r.getView("annotated_variants.v1")?.name, "annotated_variants");
  });

  test("a table missing a required column fails the contract", async () => {
    const conn = await memoryConn();
    await conn.run("CREATE TABLE annotated_variants AS SELECT 'k' AS variant_key, 'SO:1' AS consequence"); // no AF / clinsig
    await assert.rejects(
      () => assertTableMatchesView(conn, "annotated_variants", ANNOTATED_VARIANTS_V1),
      /missing column\(s\) allele_frequency, clinical_significance/,
    );
  });

  test("a nonexistent table fails the contract", async () => {
    const conn = await memoryConn();
    await assert.rejects(() => assertTableMatchesView(conn, "nope", ANNOTATED_VARIANTS_V1), /does not exist or has no columns/);
  });
});
