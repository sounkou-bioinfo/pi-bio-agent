import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { assertPortableValueMatrix, readPortableValueMatrix } from "./support/portable-value-matrix.js";

describe("duckdbNodeConn", () => {
  test("normalizes DuckDB value wrappers into portable SQL-domain shapes", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const row = await readPortableValueMatrix(conn);
      assertPortableValueMatrix(row);
    } finally {
      raw.disconnectSync();
    }
  });

  test("preserves direct null/primitive behavior", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const rows = await conn.all<{ value: string | number | boolean | null | bigint }>("SELECT NULL AS value UNION ALL SELECT 1 AS value");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.value, null);
      assert.equal(rows[1]!.value, 1);
      assert.equal(typeof rows[0]!.value, "object");
      assert.equal(typeof rows[1]!.value, "number");
    } finally {
      raw.disconnectSync();
    }
  });
});
