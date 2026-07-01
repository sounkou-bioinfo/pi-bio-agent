import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { assertColumnsPresent, createBioRegistry, describeTable, runOperation, type BioManifest, type SqlConn } from "../src/core/index.js";
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

  test("SQL is the arbiter: an operation referencing a missing column fails closed at the DuckDB binder", async () => {
    // No requiredColumns pre-declaration — the agent's SQL references allele_frequency, the table doesn't
    // have it, and DuckDB's binder fails closed with a clear error. The substrate adds no ceremony on top.
    const manifest: BioManifest = {
      schema: "pi-bio.manifest.v1", id: "needs-af", version: "0.1.0", title: "Needs AF", description: "x",       provides: {
        resolvers: [{ id: "inline.table", version: "0.1.0", title: "Inline", description: "Inline.", output: { mode: "table" } }],
        resources: [{ id: "variants", title: "Variants", kind: "virtual", resolver: "inline.table", params: { table: "variants", columns: [{ name: "variant_key", type: "TEXT" }], rows: [{ variant_key: "1:1:A:T" }] } }],
        operations: [defineBioOperationSpec({
          schema: "pi-bio.operation_spec.v1", id: "needs.af", version: "0.1.0", title: "Needs AF", description: "x",           transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT variant_key, allele_frequency FROM variants", readOnly: true },
        })],
      },
    };
    const r = createBioRegistry();
    r.registerManifest(manifest);
    r.bindResolverImpl("inline.table", inlineTableResolver);
    const conn = await memoryConn();
    await assert.rejects(
      () => runOperation(r, conn, { operationId: "needs.af", resources: ["variants"], runId: "x", now: "t" }),
      /allele_frequency/,
    );
  });
});
