import type { SqlConn } from "./ports.js";
import type { VirtualResourceSpec } from "./resources.js";

type JsonRecord = Record<string, unknown>;

const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "duckdb_catalog"]);
const SYSTEM_TABLES = new Set([
  "duckdb_columns",
  "duckdb_constraints",
  "duckdb_databases",
  "duckdb_dependencies",
  "duckdb_extensions",
  "duckdb_functions",
  "duckdb_indexes",
  "duckdb_keywords",
  "duckdb_logs",
  "duckdb_schemas",
  "duckdb_secrets",
  "duckdb_sequences",
  "duckdb_settings",
  "duckdb_tables",
  "duckdb_temporary_files",
  "duckdb_types",
  "duckdb_variables",
  "duckdb_views",
]);

export interface QueryResourceInference {
  resources: string[];
  tables: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIdent(value: string): string {
  return value.toLowerCase();
}

function resourceOutputTable(resource: VirtualResourceSpec): string | undefined {
  const table = (resource.params as { table?: unknown } | undefined)?.table;
  return typeof table === "string" && table.trim() ? table : undefined;
}

function resourceDependencySql(resource: VirtualResourceSpec): string[] {
  const params = resource.params as { sql?: unknown; inputSql?: unknown } | undefined;
  return [params?.sql, params?.inputSql].filter((sql): sql is string => typeof sql === "string" && sql.trim().length > 0);
}

function collectCteNames(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCteNames(item, out);
    return;
  }
  if (!isRecord(value)) return;
  const cteMap = value.cte_map;
  if (isRecord(cteMap) && Array.isArray(cteMap.map)) {
    for (const entry of cteMap.map) {
      if (isRecord(entry) && typeof entry.key === "string") out.add(normalizeIdent(entry.key));
    }
  }
  for (const item of Object.values(value)) collectCteNames(item, out);
}

function collectStringConstants(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStringConstants(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (
    value.class === "CONSTANT" &&
    value.type === "VALUE_CONSTANT" &&
    isRecord(value.value) &&
    value.value.is_null === false &&
    typeof value.value.value === "string"
  ) {
    out.add(value.value.value);
  }
  for (const item of Object.values(value)) collectStringConstants(item, out);
}

function collectBaseTables(value: unknown, ctes: ReadonlySet<string>, out: Map<string, { table: string; system: boolean }>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectBaseTables(item, ctes, out);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "BASE_TABLE" && typeof value.table_name === "string" && value.table_name) {
    const table = value.table_name;
    const schema = typeof value.schema_name === "string" ? value.schema_name : "";
    const key = normalizeIdent(table);
    if (!ctes.has(key)) {
      const system = SYSTEM_SCHEMAS.has(normalizeIdent(schema)) || SYSTEM_TABLES.has(key);
      out.set(key, { table, system });
    }
  }
  if (
    value.type === "TABLE_FUNCTION" &&
    isRecord(value.function) &&
    typeof value.function.function_name === "string" &&
    SYSTEM_TABLES.has(normalizeIdent(value.function.function_name))
  ) {
    out.set(`function:${normalizeIdent(value.function.function_name)}`, { table: value.function.function_name, system: true });
  }
  for (const item of Object.values(value)) collectBaseTables(item, ctes, out);
}

async function parseSqlAst(conn: SqlConn, sql: string): Promise<unknown> {
  const rows = await conn.all<{ ast?: unknown }>(`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}') AS ast`);
  const text = String(rows[0]?.ast ?? "");
  if (!text) throw new Error("query resource inference: DuckDB did not return a SQL AST");
  const ast = JSON.parse(text) as unknown;
  if (isRecord(ast) && ast.error === true) throw new Error("query resource inference: SQL could not be parsed");
  return ast;
}

/** Infer the minimal declared manifest resources an ad-hoc SQL query needs.
 *
 * This is a forcing helper, not a sandbox: it only decides which declared resources to materialize before DuckDB
 * binds and executes the query. It maps parser-discovered table references to resource `params.table` values. For
 * catalog-style schema discovery (`information_schema.columns WHERE table_name = 'x'`), string constants matching a
 * declared resource table are treated as a request to materialize that table first.
 */
export async function inferQueryResources(conn: SqlConn, sql: string, resources: readonly VirtualResourceSpec[]): Promise<QueryResourceInference> {
  const tableToResources = new Map<string, string[]>();
  const declaredTables = new Map<string, string>();
  for (const resource of resources) {
    const table = resourceOutputTable(resource);
    if (!table) continue;
    const key = normalizeIdent(table);
    declaredTables.set(key, table);
    tableToResources.set(key, [...(tableToResources.get(key) ?? []), resource.id]);
  }

  const ast = await parseSqlAst(conn, sql);
  const ctes = new Set<string>();
  collectCteNames(ast, ctes);
  const baseTables = new Map<string, { table: string; system: boolean }>();
  collectBaseTables(ast, ctes, baseTables);
  const constants = new Set<string>();
  collectStringConstants(ast, constants);

  const requestedTables = new Map<string, string>();
  const unknownTables: string[] = [];
  const readsSystemCatalog = [...baseTables.values()].some((ref) => ref.system);
  for (const [key, ref] of baseTables) {
    if (tableToResources.has(key)) requestedTables.set(key, declaredTables.get(key) ?? ref.table);
    else if (!ref.system) unknownTables.push(ref.table);
  }
  if (readsSystemCatalog) {
    for (const constant of constants) {
      const key = normalizeIdent(constant);
      if (tableToResources.has(key)) requestedTables.set(key, declaredTables.get(key) ?? constant);
    }
  }

  const inferred: string[] = [];
  for (const [key, table] of requestedTables) {
    const ids = tableToResources.get(key) ?? [];
    if (ids.length > 1) {
      throw new Error(`query resource inference: table '${table}' is produced by multiple resources (${ids.join(", ")}); pass resources explicitly`);
    }
    inferred.push(ids[0]!);
  }
  if (unknownTables.length && tableToResources.size > 0) {
    throw new Error(`query resource inference: table reference(s) not declared as manifest resource outputs: ${[...new Set(unknownTables)].join(", ")}; pass resources explicitly only for declared resources, or declare params.table for the resource`);
  }
  return { resources: inferred, tables: [...requestedTables.values()] };
}

/** Infer resources plus their declared SQL dependency closure in runnable order.
 *
 * If an ad-hoc query references a derived resource table, the derived resource must not be resolved before the
 * upstream resources its own SQL reads. This DFS returns upstream resources first, then the derived resource.
 */
export async function inferQueryResourceClosure(conn: SqlConn, sql: string, resources: readonly VirtualResourceSpec[]): Promise<QueryResourceInference> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const direct = await inferQueryResources(conn, sql, resources);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = async (resourceId: string): Promise<void> => {
    if (seen.has(resourceId)) return;
    if (visiting.has(resourceId)) throw new Error(`query resource inference: cyclic resource dependency involving '${resourceId}'`);
    const resource = byId.get(resourceId);
    if (!resource) throw new Error(`query resource inference: inferred unknown resource '${resourceId}'`);
    visiting.add(resourceId);
    for (const depSql of resourceDependencySql(resource)) {
      const deps = await inferQueryResources(conn, depSql, resources);
      for (const dep of deps.resources) await visit(dep);
    }
    visiting.delete(resourceId);
    seen.add(resourceId);
    ordered.push(resourceId);
  };

  for (const resourceId of direct.resources) await visit(resourceId);
  return { resources: ordered, tables: direct.tables };
}
