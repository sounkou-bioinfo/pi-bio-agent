import type { SqlConn } from "../core/ports.js";
import { parseStudyNoteLinks } from "../core/study.js";
import {
  createBioObservationSchema,
  observationAsOfKey,
  observationHistory,
  observationsAsOf,
  liveOutEdgesAsOf,
  recordObservation,
  type ObservationRow,
} from "../duckdb/observations.js";

// Memory unified INTO the temporal store: a memory note is observation(s) under the `agent:memory:` namespace, so
// it gets modification history + as-of + cross-agent sharing for free — the same store as facts/compute, the
// unified-data-model bet. Content is a scalar observation; each [[to]]/typed link is an EDGE-like observation
// (object_id set) that materializeBioEdgesAsOf projects into a walkable graph AS OF t. This is also Fugu's
// "persistent shared memory" (report §3.2.2): a later agent/workflow reads what was already remembered instead of
// repeating it. Files were last-write-wins with no history; the DB is append-only and never destroys a revision.
export const MEMORY_NS = "agent:memory:";
const CONTENT = "has_content";
/** A sentinel far-future instant = "now / latest" for as-of reads (lexicographically sorts after any real ISO). */
export const MEMORY_NOW = "9999-12-31T23:59:59.999Z";

export const memorySubjectId = (slug: string): string => `${MEMORY_NS}${slug}`;

export interface MemoryContent {
  slug: string;
  kind: string;
  title: string;
  hook: string;
  body: string;
  tags: string[];
}

/** A recalled memory: its content plus WHO authored the current revision (`source`). In shared memory the author
 *  is load-bearing — trust, attribution, and "who claimed this" all key off it. `null` when unattributed. */
export type RecalledMemory = MemoryContent & { author: string | null };

export async function ensureMemorySchema(conn: SqlConn): Promise<void> {
  await createBioObservationSchema(conn, { ifNotExists: true });
}

/**
 * Remember: append a content observation for the note plus one edge observation per link. Append-only — a
 * re-write SUPERSEDES the slot's current content (by subject+predicate) yet every prior revision is retained for
 * as-of + history. `now` is the recordedAt instant.
 */
export async function remember(conn: SqlConn, note: MemoryContent, now: string, author?: string): Promise<void> {
  await ensureMemorySchema(conn);
  const subject = memorySubjectId(note.slug);
  // `source` = the authoring agent. It is part of observation IDENTITY, so two agents remembering the same slug
  // are two attributed rows (both retained); the latest by recorded_at is "current". This is what makes shared
  // cross-agent memory trustworthy — you always know WHO said it.
  await recordObservation(conn, {
    statementKey: subject,
    subjectId: subject,
    predicate: CONTENT,
    value: { kind: note.kind, title: note.title, hook: note.hook, body: note.body, tags: note.tags },
    recordedAt: now,
    source: author,
  });
  const newKeys = new Set<string>();
  for (const link of parseStudyNoteLinks({ body: note.body, links: [] })) {
    const to = memorySubjectId(link.to);
    const key = `${subject}|${link.predicate}|${to}`;
    newKeys.add(key);
    await recordObservation(conn, {
      statementKey: key,
      subjectId: subject,
      predicate: link.predicate,
      objectId: to, // edge-like -> projects into bio_edges_as_of for a walkable memory graph
      recordedAt: now,
      source: author,
    });
  }
  // RETRACT links that this revision dropped: without a tombstone, a removed [[link]]'s edge observation is never
  // superseded, so it lingers in bio_edges_as_of forever (a phantom edge). Tombstone (no objectId) every
  // currently-live edge OUT of this subject that the new revision no longer declares (indexed, no full-table scan).
  for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
    if (!newKeys.has(edge.statement_key)) {
      await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
    }
  }
}

function rowToContent(row: ObservationRow | null): RecalledMemory | null {
  if (!row || row.value_json == null) return null; // a tombstone (forgotten) carries null content
  const v = JSON.parse(row.value_json) as Omit<MemoryContent, "slug">;
  return { slug: row.subject_id.slice(MEMORY_NS.length), kind: v.kind, title: v.title, hook: v.hook, body: v.body, tags: v.tags ?? [], author: row.source ?? null };
}

/** Recall a memory slug's content (and its author) AS OF a time (default now). null if it did not exist yet or was forgotten by then. */
export async function recall(conn: SqlConn, slug: string, asOf: string = MEMORY_NOW): Promise<RecalledMemory | null> {
  return rowToContent(await observationAsOfKey(conn, memorySubjectId(slug), asOf));
}

/** The full revision trail of a slug (oldest-first) — surfaces WHAT changed, WHEN, and BY WHOM (a tombstone has null content). */
export async function memoryHistory(conn: SqlConn, slug: string): Promise<{ recordedAt: string; author: string | null; content: RecalledMemory | null }[]> {
  const rows = await observationHistory(conn, memorySubjectId(slug));
  return rows.map((r) => ({ recordedAt: r.recorded_at, author: r.source ?? null, content: rowToContent(r) }));
}

/** List the memory slugs whose content is live AS OF a time (tombstoned slugs are excluded), each with its author. */
export async function listMemory(conn: SqlConn, asOf: string = MEMORY_NOW): Promise<RecalledMemory[]> {
  const rows = await observationsAsOf(conn, asOf);
  return rows
    .filter((r) => r.predicate === CONTENT && r.subject_id.startsWith(MEMORY_NS) && r.value_json != null)
    .map((r) => rowToContent(r) as RecalledMemory)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Forget: a temporal RETRACTION, not a destruction. Append a tombstone (null content, attributed to whoever
 * forgot) so recall(now) is null and listMemory omits it, while recall(as-of an earlier time) still sees the old
 * content. Memory changes are never lost.
 */
export async function forget(conn: SqlConn, slug: string, now: string, author?: string): Promise<void> {
  await ensureMemorySchema(conn);
  const subject = memorySubjectId(slug);
  await recordObservation(conn, { statementKey: subject, subjectId: subject, predicate: CONTENT, recordedAt: now, source: author });
  // Also retract the note's link edges — otherwise they linger in bio_edges_as_of as phantom edges out of a
  // forgotten node (the same reconciliation remember() does when a link is dropped).
  for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
    await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
  }
}
