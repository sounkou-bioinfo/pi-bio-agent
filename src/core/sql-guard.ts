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

// Scan a copy with STRING LITERALS / QUOTED IDENTIFIERS / COMMENTS removed, so a keyword or ';' INSIDE a literal
// (`SELECT 'drop' AS word`, `SELECT ';' AS c`) is not a false positive. DuckDB escapes quotes by doubling (''/"").
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")            // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")    // block comments
    .replace(/'(?:[^']|'')*'/g, "''")     // single-quoted string literals
    .replace(/"(?:[^"]|"")*"/g, '""');    // double-quoted identifiers
}

/** Assert `sql` is a single read-only SELECT/WITH statement; returns it trimmed (sans trailing `;`). Throws otherwise. */
export function validateReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const scan = stripLiteralsAndComments(trimmed); // check statement class on the literal-free copy
  if (scan.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("query must be a SELECT or WITH ... SELECT");
  if (forbiddenSql.test(scan)) throw new Error("query contains forbidden write/DDL keywords");
  return trimmed; // return the ORIGINAL sql (literals intact) — only the SCAN copy was stripped
}
