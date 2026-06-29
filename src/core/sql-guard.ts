// The single read-only SQL guard. One forbidden-keyword list, one definition of "a safe query", shared by
// every execution path (graph queries, operation runner, host tools) so they cannot drift apart.

const forbiddenSql = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|pragma|install|load|export|import|call|reset|begin|commit|rollback|vacuum|checkpoint|truncate|merge)\b/i;

// External-I/O denylist. A read-only query must read ONLY tables a resolver already materialized (and
// stamped a receipt for) — it may never reach out to a file or the network itself. Two bypass vectors are
// closed: (1) DuckDB reader/scan table functions, and (2) remote URI literals (httpfs replacement scans like
// `FROM 'https://…'`, or a URI passed to a reader). Both would pull external data with zero provenance.
// This bites only SELECT/WITH (operation SQL, graph reads); a resolver's own DDL is `CREATE … AS SELECT
// read_*(…)`, which is rejected earlier by the `create` keyword and so never reaches this guard.
const externalReader = /\b(read_(csv|csv_auto|parquet|json|json_auto|json_objects|json_objects_auto|ndjson|ndjson_auto|ndjson_objects|ndjson_objects_auto|text|blob|bcf|xlsx)|parquet_scan|iceberg_scan|delta_scan|postgres_scan|sqlite_scan|mysql_scan|st_read|sniff_csv|glob)\s*\(/i;
const remoteUri = /\b(https?|s3|gs|gcs|r2|az|azure|abfss|hf|ftp|ftps):\/\//i;

/** Assert `sql` is a single read-only SELECT/WITH statement; returns it trimmed (sans trailing `;`). Throws otherwise. */
export function validateReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("query must be a SELECT or WITH ... SELECT");
  if (forbiddenSql.test(trimmed)) throw new Error("query contains forbidden write/DDL keywords");
  if (externalReader.test(trimmed)) throw new Error("query may not call an external reader/scan function — external data must enter through a resolver");
  if (remoteUri.test(trimmed)) throw new Error("query may not embed a remote URI — external data must enter through a resolver");
  return trimmed;
}
