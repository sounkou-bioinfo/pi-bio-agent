import type { SqlConn } from "./ports.js";

// The read-only SQL guard. It enforces STATEMENT CLASS ONLY: a single read-only SELECT/WITH with no
// writes/DDL. That is a correctness contract — an "operation" is by definition a read-only query that produces
// a result — shared by every execution path (graph queries, operation runner, host tools) so they cannot drift.
//
// It is deliberately NOT a network/filesystem firewall. DuckDB replacement scans (`FROM 'x.parquet'`), httpfs
// remote reads (`read_parquet('https://…')`), and extension autoloading are FEATURES; policing them with
// brittle SQL regexes fights the substrate and is not the library's job. Egress is the HOST's responsibility
// (container/seccomp/Pi runtime/OS sandbox), trivially layered by whoever deploys this. The substrate's job is
// PROVENANCE — record what SQL ran, which sources/extensions it declared, what it produced — not policy. A host
// that wants a strict no-external-I/O profile can supply its own validator; the library stays permissive by
// default. (See docs/design.md: powerful by default, host-controlled effects, provenance-aware not policy-obsessed.)
const forbiddenSql = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|pragma|install|load|export|import|call|reset|begin|commit|rollback|vacuum|checkpoint|truncate|merge)\b/i;

// Remove STRING LITERALS / QUOTED IDENTIFIERS / COMMENTS so a keyword or ';' INSIDE one (`SELECT 'drop' AS word`,
// `SELECT ';' AS c`) is not a false positive. A SINGLE left-to-right scan, NOT independent regexes: precedence is
// context-dependent — a `--` INSIDE a string ('--') is not a comment, and a `'` inside a comment is not a string.
// Doing comment-strip and literal-strip as separate ordered regexes is exploitable (`SELECT '--'; DROP` would have
// its real `;`/DROP swallowed as a fake comment). DuckDB escapes quotes by doubling ('' / "").
// `blankQuotedIdents` (default true): a double-quoted identifier is blanked, so a keyword in a column alias
// (`SELECT 1 AS "drop"`) is not a false positive for the keyword check. Set FALSE to instead EMIT the identifier's
// unquoted NAME — needed for the dynamic-SQL function check, because DuckDB resolves a quoted `"query"(…)` (or a
// catalog-qualified `main."query"(…)`) to the same `query()` function, so blanking it would HIDE the call. Either
// way the scanner still parses PAST quoted identifiers (a `'` inside `"it's"` is not a string start).
function stripLiteralsAndComments(sql: string, blankQuotedIdents = true): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i], c2 = sql[i + 1];
    if (c === "'") {                               // string literal -> always blanked (it's data)
      i++;
      while (i < sql.length) { if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
      out += " ";
    } else if (c === '"') {                         // quoted identifier -> blank, or emit its unquoted name
      let ident = ""; i++;
      while (i < sql.length) { if (sql[i] === '"') { if (sql[i + 1] === '"') { ident += '"'; i += 2; continue; } i++; break; } ident += sql[i]; i++; }
      out += blankQuotedIdents ? " " : ident;
    } else if (c === "-" && c2 === "-") {          // line comment -> end of line
      i += 2; while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && c2 === "*") {          // block comment -> */
      i += 2; while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i += 2;
      out += " ";
    } else { out += c; i++; }
  }
  return out;
}

// The dynamic-SQL functions query()/query_table() EXECUTE a string as SQL — a write hidden in that string slips past
// the keyword check (the string is blanked). The function NAME survives, but a QUOTED `"query"(…)` would be blanked
// as an identifier, so check on a scan that KEEPS identifier names (unquoted), catching `query(`, `"query"(`, and
// `main."query"(` alike. (prepare/execute are covered by forbiddenSql/fixtureForbidden.)
const DYNAMIC_SQL_FN = /\bquery(_table)?\s*\(/i;
function usesDynamicSqlFn(sql: string): boolean {
  return DYNAMIC_SQL_FN.test(stripLiteralsAndComments(sql, false));
}

// Fixture SQL (approval-harness test setup) legitimately needs multi-statement DDL to seed in-memory test data
// (CREATE TABLE / INSERT / SELECT), so it is NOT read-only — but it must not reach OUTSIDE the throwaway sandbox db:
// ATTACH/DETACH (another db), COPY / EXPORT / IMPORT (file I/O), INSTALL / LOAD (extensions, incl. network-capable),
// PRAGMA / CALL / CHECKPOINT / VACUUM (engine side-effects), and the dynamic-SQL query() functions.
const fixtureForbidden = /\b(attach|detach|copy|install|load|export|import|pragma|call|reset|checkpoint|vacuum)\b/i;

/** Assert `sql` is safe to run as approval-harness FIXTURE setup in a sandbox db: DDL/DML on local tables is fine,
 *  but statements that escape the sandbox (external db, file I/O, extension load, engine side-effects) are refused. */
export function assertSafeFixtureSql(sql: string | undefined | null): void {
  if (!sql || !sql.trim()) return;
  const scan = stripLiteralsAndComments(sql);
  if (fixtureForbidden.test(scan)) throw new Error("fixtureSql may seed in-memory test data (CREATE/INSERT/SELECT) but must not ATTACH/COPY/INSTALL/LOAD/EXPORT/IMPORT/PRAGMA — those escape the sandbox (external db / file I/O / extensions / engine side-effects)");
  if (usesDynamicSqlFn(sql)) throw new Error("fixtureSql must not use the dynamic-SQL table functions query()/query_table()");
}

/**
 * AUTHORITATIVE parser-based check that `sql` calls the dynamic-SQL executor functions query()/query_table() in ANY
 * spelling — bare, quoted (`"query"(…)`), or catalog-qualified (`main."query"(…)`) — using DuckDB's OWN
 * `json_serialize_sql`, which normalizes every identifier form to the same `function_name` node (verified: an
 * alias like `AS "query"` yields NO function node, so no false positive). This is the "use the parser, not a regex"
 * check the string scan approximates; run it at the execution boundary (a conn is required) as defense-in-depth
 * OVER `validateReadOnlySelect`. Returns TRUE only on a positive detection (→ reject). Returns FALSE if the AST is
 * clean OR could not be produced (e.g. `json_serialize_sql` unavailable): the SYNC string guard is the guaranteed
 * floor, so this layer only ever ADDS a rejection, never removes the sync guard's protection.
 */
export async function sqlCallsDynamicSqlAst(conn: SqlConn, sql: string): Promise<boolean> {
  let astJson: string;
  try {
    // json_serialize_sql only PARSES (never executes) its CONSTANT string argument; inline with '' escaping.
    const rows = await conn.all<{ ast?: unknown }>(`SELECT json_serialize_sql('${sql.replace(/'/g, "''")}') AS ast`);
    astJson = String(rows[0]?.ast ?? "");
  } catch {
    return false; // AST unavailable -> defer to the sync guard (already vetted); don't reject-all
  }
  if (!astJson || /"error"\s*:\s*true/.test(astJson)) return false; // couldn't parse -> sync guard is the floor
  for (const m of astJson.matchAll(/"function_name"\s*:\s*"([^"]+)"/g)) {
    const n = m[1].toLowerCase();
    if (n === "query" || n === "query_table") return true;
  }
  return false;
}

/** Assert `sql` is a single read-only SELECT/WITH statement; returns it trimmed (sans trailing `;`). Throws otherwise. */
export function validateReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const scan = stripLiteralsAndComments(trimmed); // check statement class on the literal-free copy
  if (scan.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("query must be a SELECT or WITH ... SELECT");
  if (forbiddenSql.test(scan)) throw new Error("query contains forbidden write/DDL keywords");
  // Reject query()/query_table() in ANY form — bare, quoted (`"query"(…)`), or catalog-qualified — since each
  // resolves to the dynamic-SQL function that would run a write hidden in its (blanked) string argument.
  if (usesDynamicSqlFn(trimmed)) throw new Error("query contains a dynamic-SQL table function (query()/query_table()) — forbidden");
  return trimmed; // return the ORIGINAL sql (literals intact) — only the SCAN copy was stripped
}
