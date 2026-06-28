import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertReadOnlySingleSelect } from "../src/core/operations.js";

describe("assertReadOnlySingleSelect: declared read-only is enforced at execution", () => {
  test("accepts single SELECT/WITH queries (comments and trailing semicolon allowed)", () => {
    assert.doesNotThrow(() => assertReadOnlySingleSelect("SELECT 1"));
    assert.doesNotThrow(() => assertReadOnlySingleSelect("  with t as (select 1) select * from t ;"));
    assert.doesNotThrow(() => assertReadOnlySingleSelect("-- header\nSELECT a FROM v /* note */"));
  });

  test("fails closed on writes, side effects, and statement stacking", () => {
    for (const sql of [
      "DELETE FROM v",
      "INSERT INTO v VALUES (1)",
      "DROP TABLE v",
      "ATTACH 'x.db' AS x",
      "INSTALL httpfs",
      "PRAGMA database_list",
      "SELECT 1; DROP TABLE v",
      "CREATE TABLE v AS SELECT 1",
    ]) {
      assert.throws(() => assertReadOnlySingleSelect(sql), /single statement|read-only|forbidden/, sql);
    }
  });
});
