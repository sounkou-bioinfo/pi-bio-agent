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
});
