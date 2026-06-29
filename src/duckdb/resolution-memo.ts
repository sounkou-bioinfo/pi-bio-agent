import type { ResolverOutput, SqlConn } from "../core/ports.js";

// Resolution memoization — the lazy graph's memo table, made real. A resolver records, per materialized table,
// a CHEAP freshness token (e.g. a file's mtime+size) alongside the receipt it produced. On the next resolve,
// if the freshness token is unchanged AND the table still exists, the work is skipped and the receipt is
// replayed. This is CORRECT, not a stale-cache footgun, because the key is content FRESHNESS, not the request
// alone — the {targets}/ETag lesson: a memo keyed on params/URL alone serves stale data when the source changes.
//
// It only pays off across runs on a PERSISTENT dbPath (the memo table + the materialized table both persist);
// on :memory: the memo table starts empty each run, so lookups miss and it is a harmless no-op. The token is
// the resolver's call — file_scan uses mtime+size; a resolver with no cheap freshness check simply skips the
// memo (always re-resolves), which is the safe default.

const MEMO_TABLE = "_pi_bio_resolution_memo";

async function ensureMemo(conn: SqlConn): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS ${MEMO_TABLE} (table_name TEXT PRIMARY KEY, freshness TEXT, receipt TEXT)`);
}

async function tablePresent(conn: SqlConn, tableName: string): Promise<boolean> {
  const present = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ?`, [tableName]);
  return Number(present[0]?.n ?? 0) > 0;
}

/** Cache hit iff a row matches (table_name, freshness) AND the materialized table still exists. For resolvers
 *  that can compute a cheap freshness token up front (e.g. a file content digest). */
export async function memoLookup(conn: SqlConn, tableName: string, freshness: string): Promise<ResolverOutput | undefined> {
  await ensureMemo(conn);
  const rows = await conn.all<{ receipt: string }>(`SELECT receipt FROM ${MEMO_TABLE} WHERE table_name = ? AND freshness = ?`, [tableName, freshness]);
  if (rows.length === 0 || !(await tablePresent(conn, tableName))) return undefined;
  try {
    return JSON.parse(rows[0]!.receipt) as ResolverOutput;
  } catch {
    return undefined;
  }
}

/** Get the stored (freshness, receipt) for a table without matching — for VALIDATOR-based resolvers that must
 *  re-validate freshness against the source themselves (e.g. http.get sending the stored ETag in a conditional
 *  request). Returns the entry only if the materialized table still exists. */
export async function memoGet(conn: SqlConn, tableName: string): Promise<{ freshness: string; receipt: ResolverOutput } | undefined> {
  await ensureMemo(conn);
  const rows = await conn.all<{ freshness: string; receipt: string }>(`SELECT freshness, receipt FROM ${MEMO_TABLE} WHERE table_name = ?`, [tableName]);
  if (rows.length === 0 || !(await tablePresent(conn, tableName))) return undefined;
  try {
    return { freshness: rows[0]!.freshness, receipt: JSON.parse(rows[0]!.receipt) as ResolverOutput };
  } catch {
    return undefined;
  }
}

/** Record the receipt + freshness token after a real materialization (upsert by table name). */
export async function memoStore(conn: SqlConn, tableName: string, freshness: string, output: ResolverOutput): Promise<void> {
  await ensureMemo(conn);
  await conn.run(`DELETE FROM ${MEMO_TABLE} WHERE table_name = ?`, [tableName]);
  await conn.run(`INSERT INTO ${MEMO_TABLE} (table_name, freshness, receipt) VALUES (?, ?, ?)`, [tableName, freshness, JSON.stringify(output)]);
}
