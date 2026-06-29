import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbSqlMaterializeResolver } from "../src/duckdb/resolvers/duckdb-sql-materialize.js";

// The general resolver: materialization is declared SQL. One resolver expresses what file_scan does (read a
// file), what an httpfs read would do (a URL in the same SELECT — egress permitting, the host's call), and any
// computed projection — with no per-source TypeScript. The abstraction the three concrete resolvers were
// already an instance of.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "duckdb.sql_materialize", params });

describe("duckdb.sql_materialize: materialization as declared SQL (the general resolver)", () => {
  test("expresses the file_scan job — declared SQL over read_csv, with the source recorded in the receipt", async () => {
    const conn = await memoryConn();
    const out = await duckdbSqlMaterializeResolver(resource({
      table: "annotated",
      sql: "SELECT * FROM read_csv_auto('test/fixtures/annotated_variants.csv')",
      declaredSources: ["file:test/fixtures/annotated_variants.csv"],
    }), { conn, now: "t" });
    const rows = await conn.all<{ variant_key: string }>("SELECT variant_key FROM annotated");
    assert.ok(rows.length >= 1);
    assert.equal(out.result.pointer?.uri, "table:annotated"); // handle identifies the materialized table
    assert.deepEqual(out.sourceSnapshots.map((s) => s.source), ["file:test/fixtures/annotated_variants.csv"]);
    assert.match(out.provenance[0]!.digest ?? "", /^sha256:[0-9a-f]{64}$/); // the materialization SQL is pinned
  });

  test("materializes a pure computed query with no external source", async () => {
    const conn = await memoryConn();
    await duckdbSqlMaterializeResolver(resource({ table: "nums", sql: "SELECT * FROM (VALUES (1),(2),(3)) AS t(n)" }), { conn, now: "t" });
    const [{ n }] = await conn.all<{ n: number }>("SELECT count(*) AS n FROM nums");
    assert.equal(Number(n), 3);
  });

  test("a remote httpfs URL in the SQL is accepted (egress is the host's call), not rejected by the library", async () => {
    // we do not fetch here; we only assert the resolver builds + would run the wrapped CREATE — the guard does
    // NOT reject the URL. (Running it offline fails at the network layer, which is the host's sandbox boundary.)
    const conn = await memoryConn();
    await assert.doesNotReject(async () => {
      try {
        await duckdbSqlMaterializeResolver(resource({ table: "remote", sql: "SELECT * FROM read_csv_auto('test/fixtures/annotated_variants.csv') WHERE 'https://example.org/x' IS NOT NULL" }), { conn, now: "t" });
      } catch (e) {
        if (/valid SQL identifier|SELECT|one statement/.test((e as Error).message)) throw e; // a library policy rejection would be a bug
      }
    });
  });

  test("fails closed: bad table identifier, a non-read-only inner statement, and statement stacking", async () => {
    const conn = await memoryConn();
    await assert.rejects(() => duckdbSqlMaterializeResolver(resource({ table: "bad name", sql: "SELECT 1" }), { conn, now: "t" }), /valid SQL identifier/);
    await assert.rejects(() => duckdbSqlMaterializeResolver(resource({ table: "t", sql: "DROP TABLE x" }), { conn, now: "t" }), /SELECT/);
    await assert.rejects(() => duckdbSqlMaterializeResolver(resource({ table: "t", sql: "SELECT 1; DROP TABLE x" }), { conn, now: "t" }), /one statement/);
  });
});
