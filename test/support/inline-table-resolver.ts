import type { BioResolverImpl } from "../../src/core/manifest.js";

// Fixture/demo resolver — NOT core. It mutates a SQL connection (CREATE TABLE + INSERT) and assumes a
// table backend, so it is a concrete implementation, not a contract. Core defines the resolver contract
// (BioResolverImpl); implementations live in adapters, packs, or — like this one — test support. Promote
// to src/duckdb/resolvers/ only when a non-test consumer needs it.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Materialize a table from inline rows declared in the resource's `params`. The simplest resolver kind.
 * Returns only resolved DATA — the registry stamps receipt identity/provenance metadata.
 */
export const inlineTableResolver: BioResolverImpl = async (resource, ctx) => {
  const { table, columns, rows } = resource.params as {
    table: string;
    columns: Array<{ name: string; type: string }>;
    rows: Array<Record<string, unknown>>;
  };
  if (!IDENT_RE.test(table) || columns.some((c) => !IDENT_RE.test(c.name) || !IDENT_RE.test(c.type))) {
    throw new Error("inlineTableResolver: table/column/type names must be identifiers");
  }
  const now = ctx.now ?? new Date().toISOString();
  await ctx.conn.run(`CREATE TABLE ${table} (${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`);
  const names = columns.map((c) => c.name);
  const placeholders = names.map(() => "?").join(", ");
  for (const row of rows) {
    await ctx.conn.run(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`, names.map((n) => row[n] ?? null));
  }
  return {
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [{ source: "inline", retrievedAt: now }],
    provenance: [{ source: "inline.table", retrievedAt: now }],
  };
};
