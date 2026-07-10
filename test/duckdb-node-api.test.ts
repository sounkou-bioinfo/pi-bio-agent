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

  test("binds portable bytes, lists, and records using the prepared DuckDB types", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const bytes = new Uint8Array([0, 1, 127, 255]);
      const rows = await conn.all<{
        bytes: Uint8Array;
        values: (number | null)[];
        empty: string[];
        record: { gene: string; score: number };
      }>(
        `SELECT ?::BLOB AS bytes,
                ?::INTEGER[] AS values,
                ?::VARCHAR[] AS empty,
                ?::STRUCT(gene VARCHAR, score DOUBLE) AS record`,
        [bytes, [1, null, 3], [], { gene: "BRCA2", score: 0.75 }],
      );
      assert.deepEqual(Array.from(rows[0]!.bytes), Array.from(bytes));
      assert.deepEqual(rows.map(({ bytes: _bytes, ...row }) => row), [{
        values: [1, null, 3],
        empty: [],
        record: { gene: "BRCA2", score: 0.75 },
      }]);
    } finally {
      raw.disconnectSync();
    }
  });

  test("uses the portable scalar type contract instead of JavaScript integer heuristics", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const rows = await conn.all<{
        number_type: string;
        bigint_type: string;
        null_value: boolean;
        integer_target: number;
      }>(
        "SELECT typeof(?) AS number_type, typeof(?) AS bigint_type, ? IS NULL AS null_value, ?::INTEGER AS integer_target",
        [7, 42n, null, 7],
      );
      assert.deepEqual(rows, [{
        number_type: "DOUBLE",
        bigint_type: "BIGINT",
        null_value: true,
        integer_target: 7,
      }]);
      await assert.rejects(
        () => conn.all("SELECT ? AS value", [{}]),
        /struct parameters cannot be empty/,
      );
    } finally {
      raw.disconnectSync();
    }
  });
});
