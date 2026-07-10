import {
  type DuckDBConnection,
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

/**
 * Adapt a live `@duckdb/node-api` connection to the `SqlConn` execution port — the one DuckDB adapter, used
 * by the operation runner and the temporal observation/graph store alike. This file's only coupling to the driver is type-level (the
 * host creates and owns the `DuckDBInstance`/connection), so the rest of the package stays driver-agnostic
 * and the adapter logic remains testable through a fake port.
 */
export function duckdbNodeConn(connection: DuckDBConnection): SqlConn {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const reader = await connection.runAndReadAll(sql, params as DuckDBValue[]);
      return reader.convertRowObjects(portableSqlValueConverter) as T[];
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      await connection.run(sql, params as DuckDBValue[]);
    },
  };
}
