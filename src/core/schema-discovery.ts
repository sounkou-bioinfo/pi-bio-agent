import type { SqlConn } from "./manifest.js";

// Lean on SQL's own advantage — schema DISCOVERY — instead of pre-declaring a taxonomy of table types.
// A resolver materializes some table; DuckDB discovers its schema; an operation declares only the few
// columns it requires; the agent can write SQL to map source columns to those. There is deliberately no
// catalog of *VariantsV1 record types: the required columns are consumer-local, passed by the operation/test
// that needs them, never registered globally.

export interface DiscoveredColumn {
  name: string;
  type: string;
}

/** Discover a materialized table's columns (information_schema). The positive form of "what shape is this?". */
export async function describeTable(conn: SqlConn, table: string): Promise<DiscoveredColumn[]> {
  const rows = await conn.all<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position",
    [table],
  );
  return rows.map((r) => ({ name: r.column_name, type: r.data_type }));
}

/** Assert a discovered table has the columns a consumer needs. Consumer-local — never a global record type. */
export async function assertColumnsPresent(conn: SqlConn, table: string, requiredColumns: readonly string[]): Promise<void> {
  const cols = await describeTable(conn, table);
  if (cols.length === 0) throw new Error(`table '${table}' does not exist or has no columns`);
  const present = new Set(cols.map((c) => c.name));
  const missing = requiredColumns.filter((c) => !present.has(c));
  if (missing.length) throw new Error(`table '${table}' is missing required column(s): ${missing.join(", ")}`);
}
