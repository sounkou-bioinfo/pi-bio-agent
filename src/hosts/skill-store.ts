import type { SqlConn } from "../core/ports.js";
import { createBioObservationSchema, observationAsOfKey, observationHistory, recordObservation } from "../duckdb/observations.js";

// Skills are one of the three memory kinds (skills / facts / notes), so they get the same temporal treatment as
// memory notes: each `bio_create_skill` is an append-only observation under `skill:<name>` (supersede-by-subject,
// prior revisions retained, attributed by `source`, as-of readable). The SKILL.md FILE remains — pi loads skills
// from files — but it is the current materialization/view; the ledger is the history + truth.
export const SKILL_NS = "skill:";
const SKILL_DEF = "skill_def";
const NOW = "9999-12-31T23:59:59.999Z";

export const skillSubjectId = (name: string): string => `${SKILL_NS}${name}`;

export interface SkillDef {
  name: string;
  description: string;
  body: string;
}

/** Record a skill definition as a temporal fact (append-only; a re-create supersedes, keeping the old revision). */
export async function recordSkill(conn: SqlConn, def: SkillDef, now: string, author?: string): Promise<void> {
  await createBioObservationSchema(conn, { ifNotExists: true });
  const subject = skillSubjectId(def.name);
  await recordObservation(conn, {
    statementKey: subject,
    subjectId: subject,
    predicate: SKILL_DEF,
    value: { description: def.description, body: def.body },
    recordedAt: now,
    source: author,
  });
}

/** Recall a skill's definition (and its author) AS OF a time (default now). null if it did not exist yet. */
export async function recallSkill(conn: SqlConn, name: string, asOf: string = NOW): Promise<(SkillDef & { author: string | null }) | null> {
  const row = await observationAsOfKey(conn, skillSubjectId(name), asOf);
  if (!row || row.value_json == null) return null;
  const v = JSON.parse(row.value_json) as { description: string; body: string };
  return { name, description: v.description, body: v.body, author: row.source ?? null };
}

/** The revision trail of a skill (oldest-first) — who changed it and when. */
export async function skillHistory(conn: SqlConn, name: string): Promise<{ recordedAt: string; author: string | null }[]> {
  const rows = await observationHistory(conn, skillSubjectId(name));
  return rows.map((r) => ({ recordedAt: r.recorded_at, author: r.source ?? null }));
}
