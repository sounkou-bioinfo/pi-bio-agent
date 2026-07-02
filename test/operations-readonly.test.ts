import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { validateReadOnlySelect, sqlCallsDynamicSqlAst } from "../src/core/sql-guard.js";

// runOperation enforces the operation's declared sql.readOnly at execution time via this shared guard
// (the same one knowledge-graph queries use — one definition of "safe", no divergence).

describe("validateReadOnlySelect: the single read-only SQL guard", () => {
  test("accepts a single SELECT/WITH query and returns it trimmed", () => {
    assert.equal(validateReadOnlySelect(" select 1;\n"), "select 1");
    assert.equal(validateReadOnlySelect("WITH t AS (SELECT 1) SELECT * FROM t"), "WITH t AS (SELECT 1) SELECT * FROM t");
  });

  test("does NOT false-positive on forbidden keywords or ';' inside string literals / comments", () => {
    assert.equal(validateReadOnlySelect("SELECT 'drop' AS word"), "SELECT 'drop' AS word");
    assert.equal(validateReadOnlySelect("SELECT ';' AS c, 'a; b' AS d"), "SELECT ';' AS c, 'a; b' AS d");
    assert.equal(validateReadOnlySelect("SELECT 'it''s a delete' AS s"), "SELECT 'it''s a delete' AS s"); // '' escaped quote
    assert.equal(validateReadOnlySelect("SELECT 1 /* delete this */ AS n"), "SELECT 1 /* delete this */ AS n");
    // a REAL write keyword outside a literal still fails closed
    assert.throws(() => validateReadOnlySelect("SELECT 1; DELETE FROM v"), /one statement only/);
    assert.throws(() => validateReadOnlySelect("SELECT 'ok'; DROP TABLE v"), /one statement only/);
    // NO BYPASS: a comment marker INSIDE a string must not swallow a following real statement (single-pass scan)
    assert.throws(() => validateReadOnlySelect("SELECT '--'; DROP TABLE t"), /one statement only/);
    assert.throws(() => validateReadOnlySelect("SELECT '/*' ; DROP TABLE t"), /one statement only/);
    assert.equal(validateReadOnlySelect("SELECT '--' AS dashes"), "SELECT '--' AS dashes"); // but -- in a single-statement literal is fine
  });

  test("fails closed on writes, side effects, and statement stacking", () => {
    for (const [sql, re] of [
      ["DELETE FROM v", /SELECT/],
      ["INSERT INTO v VALUES (1)", /SELECT/],
      ["DROP TABLE v", /SELECT/],
      ["ATTACH 'x.db' AS x", /SELECT/],
      ["INSTALL httpfs", /SELECT/],
      ["PRAGMA database_list", /SELECT/],
      ["SELECT 1; DROP TABLE v", /one statement only/],
      ["CREATE TABLE v AS SELECT 1", /SELECT/],
      ["WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x", /forbidden/],
      // DuckDB dynamic-SQL table functions EXECUTE their string arg — a write hidden in the (stripped) literal must not slip past
      ["SELECT * FROM query('CREATE TABLE pwn AS SELECT 1')", /dynamic-SQL table function/],
      ["SELECT * FROM query_table('pwn', true)", /dynamic-SQL table function/],
      // BYPASS via a QUOTED identifier — `"query"` resolves to the same function, but was blanked with string literals
      ["SELECT * FROM \"query\"('CREATE TABLE pwn AS SELECT 1')", /dynamic-SQL table function/],
      ["SELECT * FROM \"query_table\"('pwn', true)", /dynamic-SQL table function/],
      // …and catalog-qualified quoted form
      ["SELECT * FROM main.\"query\"('CREATE TABLE pwn AS SELECT 1')", /dynamic-SQL table function/],
    ] as const) {
      assert.throws(() => validateReadOnlySelect(sql), re, sql);
    }
    // but a plain column/identifier literally named 'query' is fine (only the CALL form query( is rejected)
    assert.equal(validateReadOnlySelect("SELECT query FROM searches"), "SELECT query FROM searches");
    // and a keyword as a QUOTED column alias is NOT a false positive (quoted idents are blanked for the keyword check)
    assert.equal(validateReadOnlySelect('SELECT 1 AS "drop", 2 AS "query"'), 'SELECT 1 AS "drop", 2 AS "query"');
  });

  test("sqlCallsDynamicSqlAst: DuckDB's parser (json_serialize_sql) catches query()/query_table() in every spelling", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    for (const sql of [
      "SELECT * FROM query('CREATE TABLE pwn AS SELECT 1')",
      'SELECT * FROM "query"(\'CREATE TABLE pwn AS SELECT 1\')', // quoted → normalized to the function name
      'SELECT * FROM main."query"(\'x\')',                        // catalog-qualified quoted
      "SELECT * FROM query_table('pwn', true)",
    ]) assert.equal(await sqlCallsDynamicSqlAst(conn, sql), true, `AST should flag: ${sql}`);
    // benign SQL, incl. a QUOTED alias literally named "query", is NOT flagged (no function node)
    for (const sql of [
      "SELECT upper(c), count(*) FROM t GROUP BY 1",
      'SELECT 1 AS "drop", 2 AS "query"',
      "SELECT query FROM searches",
    ]) assert.equal(await sqlCallsDynamicSqlAst(conn, sql), false, `AST should allow: ${sql}`);
  });

  // The guard is statement-class only — NOT a network/filesystem firewall. DuckDB replacement scans and
  // httpfs reads are features; egress is the host's job (sandbox/seccomp/container), not the library's. So a
  // read-only SELECT that reaches a file or URL is ACCEPTED here; provenance (receipts) records it, host
  // policy decides whether it may run.
  test("accepts external readers / remote URIs / replacement scans (egress is the host's job, not the guard's)", () => {
    for (const sql of [
      "SELECT * FROM read_parquet('s3://bucket/x.parquet')",
      "WITH x AS (SELECT * FROM read_bcf('a.bcf')) SELECT * FROM x",
      "SELECT * FROM 'https://example.com/data.csv'",
      "SELECT * FROM '/tmp/local.parquet'",
    ]) {
      assert.equal(validateReadOnlySelect(sql), sql);
    }
  });

  test("accepts ordinary analytic SQL over already-materialized tables", () => {
    const sql = "WITH classified AS (SELECT variant_key, CASE WHEN allele_frequency IS NULL THEN 'no_frequency' ELSE 'included' END AS bucket FROM annotated_variants) SELECT bucket, count(*) AS n FROM classified GROUP BY bucket";
    assert.equal(validateReadOnlySelect(sql), sql);
  });
});
