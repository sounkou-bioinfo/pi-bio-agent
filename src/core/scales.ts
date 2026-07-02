import type { BioRegistry } from "./manifest.js";
import type { SqlConn } from "./ports.js";

// Ordinal scales as DATA. An `ordered` TermSet is a closed candidate set PLUS a total order (member ranks):
// ACMG benign<…<pathogenic, impact MODIFIER<LOW<MODERATE<HIGH, clinical stage I<…<IV, ECOG 0..5, Likert.
// The substrate materializes every ordered TermSet into ONE generic table so operation SQL can ORDER BY /
// threshold / compare on rank — no per-scale TypeScript, no scale zoo. Grounding a value to a level still
// goes through decideGrounding (membership against members[].id); ordering is just the rank column.
//
// This is the bet exactly: a scale is data (a ranked TermSet in the manifest); the only TS is generic —
// validate the order (in validateBioManifest) and project it to a table (here).

export const SCALE_MEMBERS_TABLE = "scale_members";

/**
 * Create `scale_members(scale_id, member_id, label, rank)` (idempotent) and load every ordered TermSet in the
 * registry into it; returns the number of member rows written. Derived purely from declared manifest data, so
 * it carries no external receipt — it is a projection of the program's own ontology declarations, made
 * queryable. An operation that wants ordering JOINs its grounded member_id to this table and uses `rank`.
 */
export async function materializeScaleMembers(registry: BioRegistry, conn: SqlConn): Promise<number> {
  // `scale_members` is a RESERVED internal table (the ordinal-scale projection). Resources resolve into this same
  // db BEFORE this runs, so a table by that name may already exist — distinguish OUR own projection (a reused
  // persistent dbPath replaying a prior run: same columns, safe to CREATE OR REPLACE) from a RESOURCE that
  // clobbered the name (a different schema): the latter fails closed rather than being silently overwritten (which
  // would hand the operation the WRONG table / misleading binder errors). Manifests must not target `scale_members`.
  const cols = await conn.all<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`, [SCALE_MEMBERS_TABLE]);
  if (cols.length > 0) {
    const have = new Set(cols.map((c) => c.column_name.toLowerCase()));
    const ours = ["scale_id", "member_id", "label", "rank"];
    if (have.size !== ours.length || !ours.every((c) => have.has(c))) {
      throw new Error(`'${SCALE_MEMBERS_TABLE}' is a reserved table name (the ordinal-scale projection) — a resource must not materialize a table called '${SCALE_MEMBERS_TABLE}'`);
    }
  }
  await conn.run(`CREATE OR REPLACE TABLE ${SCALE_MEMBERS_TABLE} (scale_id TEXT, member_id TEXT, label TEXT, rank INTEGER, PRIMARY KEY (scale_id, member_id))`);
  let rows = 0;
  for (const ts of registry.snapshot().termSets) {
    if (!ts.ordered) continue;
    for (const m of ts.members) {
      await conn.run(`INSERT INTO ${SCALE_MEMBERS_TABLE} (scale_id, member_id, label, rank) VALUES (?, ?, ?, ?)`, [ts.id, m.id, m.label ?? m.id, m.rank ?? null]);
      rows++;
    }
  }
  return rows;
}
