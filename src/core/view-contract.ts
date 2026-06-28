import type { BioViewDef, SqlConn } from "./manifest.js";

// Validate that a materialized table satisfies a declared view contract (the columnar SHAPE). This is the
// minimal "the provider produced the agreed record" check that lets interchangeable resolvers feed one
// operation. It checks required column presence only — deliberately not types, because providers may differ
// on representation (a VCF FLOAT vs a CSV DOUBLE for the same logical column). Cross-provider *identity*
// normalization is a separate, later concern; this only fixes shape.

export async function assertTableMatchesView(conn: SqlConn, table: string, view: BioViewDef): Promise<void> {
  const rows = await conn.all<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
    [table],
  );
  if (rows.length === 0) throw new Error(`view contract '${view.id}': table '${table}' does not exist or has no columns`);
  const present = new Set(rows.map((r) => r.column_name));
  const missing = view.columns.filter((c) => !present.has(c.name)).map((c) => c.name);
  if (missing.length) throw new Error(`table '${table}' does not satisfy view contract '${view.id}': missing column(s) ${missing.join(", ")}`);
}
