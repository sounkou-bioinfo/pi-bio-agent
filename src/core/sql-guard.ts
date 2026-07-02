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
function stripLiteralsAndComments(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i], c2 = sql[i + 1];
    if (c === "'" || c === '"') {                 // string literal / quoted identifier
      const q = c; i++;
      while (i < sql.length) { if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } i++; break; } i++; }
      out += " ";
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

/** Assert `sql` is a single read-only SELECT/WITH statement; returns it trimmed (sans trailing `;`). Throws otherwise. */
export function validateReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const scan = stripLiteralsAndComments(trimmed); // check statement class on the literal-free copy
  if (scan.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("query must be a SELECT or WITH ... SELECT");
  if (forbiddenSql.test(scan)) throw new Error("query contains forbidden write/DDL keywords");
  // DuckDB's dynamic-SQL table functions EXECUTE a string as SQL, so a write hidden in that string (which the
  // literal-strip removes from `scan`) would otherwise slip past the keyword check: `SELECT * FROM query('CREATE
  // TABLE pwn AS SELECT 1')` runs DDL. The function NAME is outside the string, so it survives in `scan` — reject
  // the call form (not a bare `query` column) at the boundary. (prepare/execute are covered by forbiddenSql.)
  if (/\bquery(_table)?\s*\(/i.test(scan)) throw new Error("query contains a dynamic-SQL table function (query()/query_table()) — forbidden");
  return trimmed; // return the ORIGINAL sql (literals intact) — only the SCAN copy was stripped
}
