import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import type { SqlConn } from "../core/ports.js";

/**
 * Adapt a live `@duckdb/node-api` connection to the `SqlConn` execution port — the one DuckDB adapter, used
 * by the operation runner and the KG sync alike. This file's only coupling to the driver is type-level (the
 * host creates and owns the `DuckDBInstance`/connection), so the rest of the package stays driver-agnostic
 * and the adapter logic remains testable through a fake port.
 */
export function duckdbNodeConn(connection: DuckDBConnection): SqlConn {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const reader = await connection.runAndReadAll(sql, params as DuckDBValue[]);
      return reader.getRowObjects() as T[];
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      await connection.run(sql, params as DuckDBValue[]);
    },
  };
}
