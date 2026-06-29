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

  // The receipt-bypass hole: a SELECT that reads a file or the network itself sidesteps resolver +
  // provenance. External data must enter only through a resolver (which stamps a receipt), so reader/scan
  // table functions and remote URI literals fail closed even though they are valid read-only SELECTs.
  test("fails closed on external readers and remote URIs (no unreceipted I/O)", () => {
    for (const [sql, re] of [
      ["SELECT * FROM read_parquet('s3://bucket/x.parquet')", /external reader/],
      ["SELECT * FROM read_csv_auto('/etc/passwd')", /external reader/],
      ["WITH x AS (SELECT * FROM read_bcf('a.bcf')) SELECT * FROM x", /external reader/],
      ["SELECT * FROM parquet_scan('x.parquet')", /external reader/],
      ["SELECT * FROM 'https://example.com/data.csv'", /remote URI/],
      ["SELECT * FROM t WHERE src = 'gs://bucket/o'", /remote URI/],
    ] as const) {
      assert.throws(() => validateReadOnlySelect(sql), re, sql);
    }
  });

  test("still accepts ordinary analytic SQL over already-materialized tables", () => {
    // the flagship shape: classify rows from a resolver-materialized table, no I/O of its own
    const sql = "WITH classified AS (SELECT variant_key, CASE WHEN allele_frequency IS NULL THEN 'no_frequency' ELSE 'included' END AS bucket FROM annotated_variants) SELECT bucket, count(*) AS n FROM classified GROUP BY bucket";
    assert.equal(validateReadOnlySelect(sql), sql);
  });
});
