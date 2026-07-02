import type { SqlConn } from "../core/ports.js";

// A SOUND, un-evadable hermeticity check over the DuckDB PHYSICAL PLAN — replacing the SQL-text denylist for ambient
// reads (which a comment / quoted identifier / replacement scan could slip past, since those are text tricks that all
// resolve to the SAME plan operators). A query is HERMETIC only if every data-source LEAF in its plan is a base-table
// scan of a table the run actually RESOLVED (receipt-pinned), or a pure/constant source — NO table function, file
// reader, or replacement scan (which pull data no receipt pins). Fails CLOSED on any EXPLAIN/parse error or unknown
// leaf, so "can't prove" == "don't memoize". Volatile scalar functions (random()/now()) do NOT appear in the physical
// plan (only output column names do), so they are checked separately by the caller.

interface PlanNode {
  name?: string;
  children?: PlanNode[];
  extra_info?: { Table?: string } & Record<string, unknown>;
}

// Leaf operators that read NO external/ambient data. SEQ_SCAN is a base table (its Table is checked against the
// resolved set); the rest are constant/empty producers. Anything else at a leaf (a table function, a file reader,
// an unknown operator) is treated as ambient -> non-hermetic.
const BASE_TABLE_SCANS = new Set(["SEQ_SCAN", "INDEX_SCAN"]);
const PURE_LEAVES = new Set(["DUMMY_SCAN", "EMPTY_RESULT", "COLUMN_DATA_SCAN"]);

/** The set of base tables currently in the connection's `main` schema — the run's RESOLVED (receipt-pinned) inputs
 *  on a `:memory:` db (plus anything init SQL created, which the caller vets separately). */
export async function resolvedBaseTables(conn: SqlConn): Promise<Set<string>> {
  const rows = await conn.all<{ n: string }>(
    "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'",
  );
  return new Set(rows.map((r) => r.n));
}

function extractPlanJson(rows: Array<Record<string, unknown>>): PlanNode[] | undefined {
  // EXPLAIN (FORMAT json) returns one row { explain_key: 'physical_plan', explain_value: '[ ... ]' }. Find the value
  // that parses as a plan array (robust to column-name/order differences).
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (typeof v === "string" && v.trimStart().startsWith("[")) {
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) return parsed as PlanNode[];
        } catch {
          /* not this column */
        }
      }
    }
  }
  return undefined;
}

/**
 * Prove (via the query plan) that `sql` reads ONLY tables in `resolvedTables` (and pure/constant sources) — no
 * ambient file/table-function/replacement-scan reads. Returns false (fail closed) on any error or an unrecognized
 * leaf. `sql` must already be executable on `conn` (bindings/init applied) — the caller runs this AFTER the query
 * succeeded, so EXPLAIN plans the exact same statement.
 */
export async function sqlReadsOnlyResolvedTables(conn: SqlConn, sql: string, resolvedTables: ReadonlySet<string>): Promise<boolean> {
  let plan: PlanNode[] | undefined;
  try {
    plan = extractPlanJson(await conn.all<Record<string, unknown>>(`EXPLAIN (FORMAT json) ${sql}`));
  } catch {
    return false; // can't EXPLAIN -> can't prove hermetic -> fail closed
  }
  if (!plan || plan.length === 0) return false;

  let hermetic = true;
  const visit = (n: PlanNode): void => {
    if (!hermetic) return;
    if (!n || typeof n !== "object") { hermetic = false; return; }
    const name = (n.name ?? "").toUpperCase();
    const children = Array.isArray(n.children) ? n.children : [];
    if (children.length === 0) {
      if (BASE_TABLE_SCANS.has(name)) {
        // strip the catalog.schema. prefix from e.g. "memory.main.variants"
        const table = (n.extra_info?.Table ?? "").split(".").pop() ?? "";
        if (!resolvedTables.has(table)) hermetic = false; // scanning an unpinned table -> not provable
      } else if (!PURE_LEAVES.has(name)) {
        hermetic = false; // a table function / file reader / unknown leaf reads ambient data
      }
    } else {
      for (const c of children) visit(c);
    }
  };
  for (const root of plan) visit(root);
  return hermetic;
}

/**
 * Prove (via DuckDB's OWN parse-time AST + its function-stability metadata) whether `sql` calls any NON-deterministic
 * function — `VOLATILE` (random/uuid/nextval/gen_random_uuid) or `CONSISTENT_WITHIN_QUERY` (now/current_timestamp),
 * both of which vary across runs, so the input CASID can't determine the output. Uses CORE `json_serialize_sql`
 * (no extension) + `duckdb_functions().stability`, so a quoted/aliased/commented call can't hide the function name
 * from a regex (`"random"()` normalizes to `random` in the AST). Fails CLOSED (returns true = treat as
 * non-deterministic → do NOT memoize) on any parse/serialize error.
 */
export async function sqlUsesNonDeterministicFn(conn: SqlConn, sql: string): Promise<boolean> {
  // The `current_*` / `localtime*` forms are non-deterministic KEYWORDS, not function CALLS, so they never appear as
  // a `function_name` in the AST (nor in the physical plan). Keywords can't be quoted/aliased to hide, so a tiny
  // keyword regex is sound for them (a comment merely mentioning the word only over-skips a memo — safe).
  if (/\bcurrent_(timestamp|date|time)\b|\blocaltime(stamp)?\b|\b(transaction|statement)_timestamp\b/i.test(sql)) return true;
  let astJson: string;
  try {
    // json_serialize_sql only PARSES (never executes) its argument and requires a CONSTANT string, so inline `sql`
    // as a SQL literal with '' escaping. No execution => no injection-to-execution risk; a malformed parse just
    // returns an error JSON below (fail closed).
    const rows = await conn.all<Record<string, unknown>>(`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}') AS ast`);
    astJson = String((rows[0] as { ast?: unknown } | undefined)?.ast ?? "");
  } catch {
    return true; // can't serialize -> can't prove deterministic -> fail closed
  }
  if (!astJson || /"error"\s*:\s*true/.test(astJson)) return true; // parser error JSON -> fail closed
  const names = new Set<string>();
  for (const m of astJson.matchAll(/"function_name"\s*:\s*"([^"]+)"/g)) names.add(m[1].toLowerCase());
  if (names.size === 0) return false; // no function calls -> deterministic
  // DuckDB explicitly marks non-deterministic functions; everything else (operators, aggregates, pure scalars) is
  // CONSISTENT and safe. So flag ONLY the explicitly non-deterministic ones — no over-skip of normal queries.
  const placeholders = [...names].map(() => "?").join(",");
  const rows = await conn.all<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM duckdb_functions() WHERE lower(function_name) IN (${placeholders}) AND stability IN ('VOLATILE', 'CONSISTENT_WITHIN_QUERY')`,
    [...names],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}
