import {
  type DuckDBConnection,
  type DuckDBPreparedStatement,
  type DuckDBType,
  type DuckDBValue,
  type DuckDBValueConverter,
  arrayFromArrayValue,
  arrayFromListValue,
  bigintFromBigIntValue,
  booleanFromValue,
  createDuckDBValueConverter,
  DuckDBTypeId,
  nullConverter,
  numberFromValue,
  objectArrayFromMapValue,
  objectFromIntervalValue,
  objectFromStructValue,
  objectFromUnionValue,
  stringFromValue,
  bytesFromBitValue,
  bytesFromBlobValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  BIGINT,
  BLOB,
  BOOLEAN,
  DOUBLE,
  HUGEINT,
  LIST,
  SQLNULL,
  STRUCT,
  VARCHAR,
  blobValue,
  listValue,
  structValue,
} from "@duckdb/node-api";
import type { SqlConn, SqlValue } from "../core/ports.js";

const unsupportedPortableConversion: DuckDBValueConverter<SqlValue> = (_value, type) => {
  throw new Error(`Unsupported DuckDB value type for SQL transport: ${type.typeId} (${type.toString()})`);
};

const canonicalTimestampTzValue: DuckDBValueConverter<SqlValue> = (value, type) => {
  if (value instanceof DuckDBTimestampTZValue) {
    if (value.isFinite) {
      return `${new DuckDBTimestampValue(value.micros).toString()}+00`;
    }
    return value.toString();
  }
  throw new Error(`Expected DuckDBTimestampTZValue for type ${type}`);
};

const portableSqlValueConverter = createDuckDBValueConverter<SqlValue>({
  [DuckDBTypeId.INVALID]: unsupportedPortableConversion,
  [DuckDBTypeId.BOOLEAN]: booleanFromValue,
  [DuckDBTypeId.TINYINT]: numberFromValue,
  [DuckDBTypeId.SMALLINT]: numberFromValue,
  [DuckDBTypeId.INTEGER]: numberFromValue,
  [DuckDBTypeId.BIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UTINYINT]: numberFromValue,
  [DuckDBTypeId.USMALLINT]: numberFromValue,
  [DuckDBTypeId.UINTEGER]: numberFromValue,
  [DuckDBTypeId.UBIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.FLOAT]: numberFromValue,
  [DuckDBTypeId.DOUBLE]: numberFromValue,
  [DuckDBTypeId.TIMESTAMP]: stringFromValue,
  [DuckDBTypeId.DATE]: stringFromValue,
  [DuckDBTypeId.TIME]: stringFromValue,
  [DuckDBTypeId.INTERVAL]: objectFromIntervalValue,
  [DuckDBTypeId.HUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UHUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.VARCHAR]: stringFromValue,
  [DuckDBTypeId.BLOB]: bytesFromBlobValue,
  [DuckDBTypeId.DECIMAL]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_S]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_MS]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_NS]: stringFromValue,
  [DuckDBTypeId.ENUM]: stringFromValue,
  [DuckDBTypeId.LIST]: arrayFromListValue,
  [DuckDBTypeId.STRUCT]: objectFromStructValue,
  [DuckDBTypeId.MAP]: objectArrayFromMapValue,
  [DuckDBTypeId.ARRAY]: arrayFromArrayValue,
  [DuckDBTypeId.UUID]: stringFromValue,
  [DuckDBTypeId.UNION]: objectFromUnionValue,
  [DuckDBTypeId.BIT]: bytesFromBitValue,
  [DuckDBTypeId.TIME_TZ]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_TZ]: canonicalTimestampTzValue,
  [DuckDBTypeId.ANY]: unsupportedPortableConversion,
  [DuckDBTypeId.BIGNUM]: bigintFromBigIntValue,
  [DuckDBTypeId.SQLNULL]: nullConverter,
  [DuckDBTypeId.STRING_LITERAL]: unsupportedPortableConversion,
  [DuckDBTypeId.INTEGER_LITERAL]: unsupportedPortableConversion,
  [DuckDBTypeId.TIME_NS]: stringFromValue,
});

interface PortableDuckDBInput {
  value: DuckDBValue;
  type: DuckDBType;
}

function portableInputValue(value: unknown, seen: Set<object> = new Set(), depth = 0): PortableDuckDBInput {
  if (value === null) return { value: null, type: SQLNULL };
  if (typeof value === "boolean") return { value, type: BOOLEAN };
  if (typeof value === "number") return { value, type: DOUBLE };
  if (typeof value === "string") return { value, type: VARCHAR };
  if (typeof value === "bigint") {
    const type = value >= -9223372036854775808n && value <= 9223372036854775807n ? BIGINT : HUGEINT;
    return { value, type };
  }
  if (value instanceof Uint8Array) return { value: blobValue(value), type: BLOB };
  if (typeof value !== "object") {
    throw new Error("Unsupported SQL parameter value; expected a portable SQL value");
  }
  if (seen.has(value)) throw new Error("SQL parameter values cannot be cyclic");
  if (depth > 16) throw new Error("SQL parameter nesting exceeds 16 levels");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => portableInputValue(item, seen, depth + 1));
      const concreteTypes = [...new Map(
        items.filter((_item, index) => value[index] !== null).map((item) => [item.type.toString(), item.type]),
      ).values()];
      if (concreteTypes.length > 1) {
        throw new Error("SQL list parameters must have one concrete element type");
      }
      const elementType = concreteTypes[0] ?? VARCHAR;
      return { value: listValue(items.map((item) => item.value)), type: LIST(elementType) };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const rawEntries = Object.entries(value);
      if (rawEntries.length === 0) {
        throw new Error("SQL struct parameters cannot be empty because they have no inferable field types");
      }
      const entries = rawEntries.map(([key, item]) => [key, portableInputValue(item, seen, depth + 1)] as const);
      return {
        value: structValue(Object.fromEntries(entries.map(([key, item]) => [key, item.value]))),
        type: STRUCT(Object.fromEntries(entries.map(([key, item]) => [key, item.type]))),
      };
    }
    throw new Error("Unsupported SQL parameter object; expected an array, byte array, or plain record");
  } finally {
    seen.delete(value);
  }
}

function bindPortableParams(statement: DuckDBPreparedStatement, params: readonly unknown[]): void {
  if (statement.parameterCount !== params.length) {
    throw new Error(
      "SQL parameter count mismatch: statement expects " + statement.parameterCount + ", received " + params.length,
    );
  }
  params.forEach((raw, offset) => {
    const index = offset + 1;
    const input = portableInputValue(raw);
    const expectedId = statement.parameterTypeId(index);
    const numberType =
      expectedId === DuckDBTypeId.TINYINT || expectedId === DuckDBTypeId.SMALLINT ||
      expectedId === DuckDBTypeId.INTEGER || expectedId === DuckDBTypeId.UTINYINT ||
      expectedId === DuckDBTypeId.USMALLINT || expectedId === DuckDBTypeId.UINTEGER ||
      expectedId === DuckDBTypeId.FLOAT || expectedId === DuckDBTypeId.DOUBLE;
    const bigintType =
      expectedId === DuckDBTypeId.BIGINT || expectedId === DuckDBTypeId.HUGEINT ||
      expectedId === DuckDBTypeId.UBIGINT || expectedId === DuckDBTypeId.UHUGEINT ||
      expectedId === DuckDBTypeId.BIGNUM;
    const useExpectedType =
      (typeof raw === "number" && numberType) ||
      (typeof raw === "bigint" && bigintType) ||
      (typeof raw === "boolean" && expectedId === DuckDBTypeId.BOOLEAN) ||
      (typeof raw === "string" && (expectedId === DuckDBTypeId.VARCHAR || expectedId === DuckDBTypeId.ENUM)) ||
      (raw instanceof Uint8Array && expectedId === DuckDBTypeId.BLOB);
    statement.bindValue(index, input.value, useExpectedType ? statement.parameterType(index) : input.type);
  });
}

async function prepareLastStatement(connection: DuckDBConnection, sql: string): Promise<DuckDBPreparedStatement> {
  const extracted = await connection.extractStatements(sql);
  for (let index = 0; index < extracted.count - 1; index += 1) {
    const statement = await extracted.prepare(index);
    try {
      await statement.run();
    } finally {
      statement.destroySync();
    }
  }
  return extracted.prepare(extracted.count - 1);
}

/**
 * Adapt a live `@duckdb/node-api` connection to the `SqlConn` execution port — the one DuckDB adapter, used
 * by the operation runner and the temporal observation/graph store alike. This file's only coupling to the driver is type-level (the
 * host creates and owns the `DuckDBInstance`/connection), so the rest of the package stays driver-agnostic
 * and the adapter logic remains testable through a fake port. Input values use a canonical host-neutral mapping
 * rather than the driver's integer heuristic, so local, HTTP, and ducknng transports bind the same logical types.
 */
export function duckdbNodeConn(connection: DuckDBConnection): SqlConn {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      if (params.length === 0) {
        const reader = await connection.runAndReadAll(sql);
        return reader.convertRowObjects(portableSqlValueConverter) as T[];
      }
      const statement = await prepareLastStatement(connection, sql);
      try {
        bindPortableParams(statement, params);
        const reader = await statement.runAndReadAll();
        return reader.convertRowObjects(portableSqlValueConverter) as T[];
      } finally {
        statement.destroySync();
      }
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      if (params.length === 0) {
        await connection.run(sql);
        return;
      }
      const statement = await prepareLastStatement(connection, sql);
      try {
        bindPortableParams(statement, params);
        await statement.run();
      } finally {
        statement.destroySync();
      }
    },
  };
}
