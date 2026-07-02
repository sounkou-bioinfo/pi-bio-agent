import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateReadOnlySelect } from "../src/core/sql-guard.js";

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
    ] as const) {
      assert.throws(() => validateReadOnlySelect(sql), re, sql);
    }
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
