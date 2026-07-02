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
