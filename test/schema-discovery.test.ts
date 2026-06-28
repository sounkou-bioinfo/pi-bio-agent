import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { assertColumnsPresent, createBioRegistry, describeTable, runOperation, type DomainPackManifest, type SqlConn } from "../src/core/index.js";
import { defineBioOperationSpec } from "../src/core/operation-spec.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

// Lean on schema discovery; do not pre-declare a taxonomy of table types. The substrate offers generic
// introspection (describeTable / assertColumnsPresent), and an operation declares only the few columns it
// needs — checked against what the provider actually materialized.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("schema discovery (no record-type taxonomy)", () => {
  test("describeTable returns the columns a provider materialized", async () => {
    const conn = await memoryConn();
    await conn.run("CREATE TABLE t AS SELECT 'k' AS variant_key, 0.1::DOUBLE AS allele_frequency");
    const cols = await describeTable(conn, "t");
    assert.deepEqual(cols.map((c) => c.name), ["variant_key", "allele_frequency"]);
  });

  test("assertColumnsPresent passes for present columns and fails clearly otherwise", async () => {
    const conn = await memoryConn();
    await conn.run("CREATE TABLE t AS SELECT 'k' AS variant_key");
    await assert.doesNotReject(() => assertColumnsPresent(conn, "t", ["variant_key"]));
    await assert.rejects(() => assertColumnsPresent(conn, "t", ["variant_key", "allele_frequency"]), /missing required column\(s\): allele_frequency/);
    await assert.rejects(() => assertColumnsPresent(conn, "absent", ["x"]), /does not exist or has no columns/);
  });

  test("runOperation fails closed (clearly) when a provider's table lacks a required column", async () => {
    // The provider here materializes only variant_key, but the operation declares it needs allele_frequency.
    const manifest: DomainPackManifest = {
      schema: "pi-bio.domain_pack_manifest.v1", id: "needs-af", version: "0.1.0", title: "Needs AF", description: "x", domains: ["genomics"],
      provides: {
        resolvers: [{ id: "inline.table", version: "0.1.0", title: "Inline", description: "Inline.", output: { mode: "table" } }],
        resources: [{ id: "variants", title: "Variants", kind: "virtual", resolver: "inline.table", params: { table: "variants", columns: [{ name: "variant_key", type: "TEXT" }], rows: [{ variant_key: "1:1:A:T" }] } }],
        operations: [defineBioOperationSpec({
          schema: "pi-bio.operation_spec.v1", id: "needs.af", version: "0.1.0", title: "Needs AF", description: "x", domains: ["genomics"],
          transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT variant_key FROM variants", readOnly: true, requiredColumns: ["variant_key", "allele_frequency"] },
        })],
      },
    };
    const r = createBioRegistry();
    r.registerManifest(manifest);
    r.bindResolverImpl("inline.table", inlineTableResolver);
    const conn = await memoryConn();
    await assert.rejects(
      () => runOperation(r, conn, { operationId: "needs.af", resources: ["variants"], runId: "x", now: "t" }),
      /requires column\(s\) not found in resolved inputs: allele_frequency/,
    );
  });
});
