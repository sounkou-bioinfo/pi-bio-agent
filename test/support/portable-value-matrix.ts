import assert from "node:assert/strict";
import { DuckDBTimestampValue } from "@duckdb/node-api";
import type { SqlConn } from "../../src/core/ports.js";

export const PORTABLE_VALUE_MATRIX_SQL = `
  SELECT
    CAST('9223372036854775807' AS BIGINT) AS bigint_value,
    CAST('170141183460469231731687303715884105727' AS HUGEINT) AS hugeint_value,
    CAST('1.2300' AS DECIMAL(10,4)) AS decimal_value,
    CAST('2026-01-02' AS DATE) AS date_value,
    CAST('12:34:56.123456' AS TIME) AS time_value,
    CAST('12:34:56.123456+00' AS TIME WITH TIME ZONE) AS time_tz_value,
    CAST('2026-01-02 03:04:05.678901' AS TIMESTAMP) AS timestamp_value,
    CAST('2026-01-02 03:04:05.678901+00' AS TIMESTAMP WITH TIME ZONE) AS timestamptz_value,
    CAST('abc' AS BLOB) AS blob_value,
    CAST('10101010' AS BIT) AS bit_value,
    INTERVAL '1 year 2 months 3 days 00:04:05.123456' AS interval_value,
    CAST('x' AS ENUM('x', 'y')) AS enum_value,
    [1, 2, 3] AS list_value,
    CAST([1, 2, 3] AS INTEGER[3]) AS array_value,
    STRUCT_PACK(a := 1, b := 'text') AS struct_value,
    MAP([1, 2, 3], [10, 20, 30]) AS map_value,
    CAST(1 AS UNION(a INTEGER, b VARCHAR)) AS union_value,
    CAST('123456789012345678901234567890' AS BIGNUM) AS bignum_value,
    CAST(0.0/0.0 AS DOUBLE) AS nan_value,
    CAST(1.0/0.0 AS DOUBLE) AS inf_value,
    CAST(-1.0/0.0 AS DOUBLE) AS neg_inf_value,
    CAST(-0.0 AS DOUBLE) AS negative_zero_value,
    CAST('123e4567-e89b-12d3-a456-426614174000' AS UUID) AS uuid_value
`;

function expectedTimestamptzValue(utcMicros: bigint): string {
  return `${new DuckDBTimestampValue(utcMicros).toString()}+00`;
}

export async function readPortableValueMatrix(conn: SqlConn): Promise<Record<string, unknown>> {
  await conn.run("SET TimeZone='UTC'");
  const rows = await conn.all<Record<string, unknown>>(PORTABLE_VALUE_MATRIX_SQL);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function toPlainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

export function assertPortableValueMatrix(row: Record<string, unknown>): void {
  assert.equal(typeof row.bigint_value, "bigint");
  assert.equal(row.bigint_value, 9_223_372_036_854_775_807n);

  assert.equal(typeof row.hugeint_value, "bigint");
  assert.equal(row.hugeint_value, 170141183460469231731687303715884105727n);

  assert.equal(typeof row.decimal_value, "string");
  assert.equal(row.decimal_value, "1.2300");

  assert.equal(typeof row.date_value, "string");
  assert.equal(row.date_value, "2026-01-02");

  assert.equal(typeof row.time_value, "string");
  assert.equal(row.time_value, "12:34:56.123456");

  assert.equal(typeof row.time_tz_value, "string");
  assert.equal(row.time_tz_value, "12:34:56.123456+00");

  assert.equal(typeof row.timestamp_value, "string");
  assert.equal(row.timestamp_value, "2026-01-02 03:04:05.678901");

  assert.equal(typeof row.timestamptz_value, "string");
  assert.equal(row.timestamptz_value, expectedTimestamptzValue(1_767_323_045_678_901n));

  assert.ok(row.blob_value instanceof Uint8Array);
  assert.deepEqual(Buffer.from(row.blob_value), Buffer.from([97, 98, 99]));

  assert.ok(row.bit_value instanceof Uint8Array);
  assert.equal(row.bit_value[row.bit_value.length - 1], 170);
  assert.equal(row.bit_value.length, 2);

  assert.deepEqual(toPlainRecord(row.interval_value), { months: 14, days: 3, micros: 245123456n });

  assert.equal(typeof row.enum_value, "string");
  assert.equal(row.enum_value, "x");

  assert.deepEqual(row.list_value, [1, 2, 3]);
  assert.deepEqual(row.array_value, [1, 2, 3]);

  assert.deepEqual(toPlainRecord(row.struct_value), {
    a: 1,
    b: "text",
  });

  assert.deepEqual(
    Array.isArray(row.map_value)
      ? row.map_value.map((entry) => toPlainRecord(entry))
      : row.map_value,
    [
      { key: 1, value: 10 },
      { key: 2, value: 20 },
      { key: 3, value: 30 },
    ],
  );

  assert.deepEqual(toPlainRecord(row.union_value), { tag: "a", value: 1 });

  assert.equal(typeof row.bignum_value, "bigint");
  assert.equal(row.bignum_value, 123_456_789_012_345_678_901_234_567_890n);

  assert.equal(typeof row.uuid_value, "string");
  assert.equal(row.uuid_value, "123e4567-e89b-12d3-a456-426614174000");

  assert.equal(typeof row.nan_value, "number");
  assert.equal(typeof row.inf_value, "number");
  assert.equal(typeof row.neg_inf_value, "number");
  assert.equal(typeof row.negative_zero_value, "number");
  assert.ok(Number.isNaN(row.nan_value));
  assert.equal(row.inf_value, Number.POSITIVE_INFINITY);
  assert.equal(row.neg_inf_value, Number.NEGATIVE_INFINITY);
  assert.ok(Object.is(row.negative_zero_value, -0));
}
