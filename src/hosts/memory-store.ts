import type { SqlConn } from "../core/ports.js";
import { parseStudyNoteLinks } from "../core/study.js";
import {
  createBioObservationSchema,
  observationAsOfKey,
  observationHistory,
  observationsAsOf,
  liveOutEdgesAsOf,
  recordObservation,
  monotonicRecordedAt,
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

// The memory store is a STATE MACHINE over a slug's CURRENT content (remember/forget change which revision is
// "latest"). The observation store's equal-timestamp tiebreak is hash-arbitrary (observations.ts: observation_id
// DESC), so a same-millisecond remember→forget (systemClock() has ms resolution — two rapid tool calls collide)
// would resolve by hash, NOT operation order: recall(now) could return the content OR the tombstone at random.
// The store's contract is that state-mutating producers use a strictly-monotonic recordedAt; enforce it here by
// advancing `now` to strictly after the slug's current latest revision. Append-only history is preserved (the
// advance only moves a colliding write 1ms forward — earlier revisions keep their real timestamps).
// Memory + skill stores share the SAME monotonic-recordedAt state-machine rule (see observations.monotonicRecordedAt);
// this is the memory slot's binding of it to the MEMORY_NOW sentinel.
const monotonicNow = (conn: SqlConn, subject: string, now: string): Promise<string> => monotonicRecordedAt(conn, subject, now, MEMORY_NOW);

/** A citation backing a memory note — where the claim came from. Carried in the TEMPORAL store (not just the
 *  file view) so shared/as-of recall keeps its provenance: a memory without its sources is an unfalsifiable claim. */
export interface MemorySource {
  path?: string;
  url?: string;
  locator?: string;
  quote?: string;
}

export interface MemoryContent {
  slug: string;
  kind: string;
  title: string;
  hook: string;
  body: string;
  tags: string[];
  /** citations backing the note; persisted into the ledger so `recall`/shared memory don't lose provenance. */
  sources?: MemorySource[];
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
export async function remember(conn: SqlConn, note: MemoryContent, wallNow: string, author?: string): Promise<void> {
  await ensureMemorySchema(conn);
  const subject = memorySubjectId(note.slug);
  const now = await monotonicNow(conn, subject, wallNow); // strictly after the slug's current revision (deterministic latest-wins)
  // `source` = the authoring agent. It is part of observation IDENTITY, so two agents remembering the same slug
  // are two attributed rows (both retained); the latest by recorded_at is "current". This is what makes shared
  // cross-agent memory trustworthy — you always know WHO said it.
  await recordObservation(conn, {
    statementKey: subject,
    subjectId: subject,
    predicate: CONTENT,
    value: { kind: note.kind, title: note.title, hook: note.hook, body: note.body, tags: note.tags, ...(note.sources && note.sources.length ? { sources: note.sources } : {}) },
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
  // ONLY reconcile MEMORY's own wikilink edges (statement_key `${subject}|<pred>|<to>`, see the newKeys above) —
  // NOT every live edge out of the subject. Another subsystem may have recorded an unrelated edge fact from the same
  // `agent:memory:<slug>` subject (a different statement_key); tombstoning that here would be silent data loss.
  const memoryEdgePrefix = `${subject}|`;
  for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
    if (edge.statement_key.startsWith(memoryEdgePrefix) && !newKeys.has(edge.statement_key)) {
      await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
    }
  }
}

function rowToContent(row: ObservationRow | null): RecalledMemory | null {
  if (!row || row.value_json == null) return null; // a tombstone (forgotten) carries null content
  const v = JSON.parse(row.value_json) as Omit<MemoryContent, "slug">;
  return { slug: row.subject_id.slice(MEMORY_NS.length), kind: v.kind, title: v.title, hook: v.hook, body: v.body, tags: v.tags ?? [], ...(v.sources && v.sources.length ? { sources: v.sources } : {}), author: row.source ?? null };
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
export async function forget(conn: SqlConn, slug: string, wallNow: string, author?: string): Promise<void> {
  await ensureMemorySchema(conn);
  const subject = memorySubjectId(slug);
  const now = await monotonicNow(conn, subject, wallNow); // strictly after the current content so a same-ms remember→forget deterministically forgets
  await recordObservation(conn, { statementKey: subject, subjectId: subject, predicate: CONTENT, recordedAt: now, source: author });
  // Also retract the note's OWN link edges (statement_key `${subject}|…`) — otherwise they linger in bio_edges_as_of
  // as phantom edges out of a forgotten node. Only memory's wikilink edges, NOT an unrelated subsystem's edge fact
  // from the same subject (that would be silent data loss); same scoping as remember()'s reconciliation.
  const memoryEdgePrefix = `${subject}|`;
  for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
    if (edge.statement_key.startsWith(memoryEdgePrefix)) {
      await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
    }
  }
}
