import type { SqlConn } from "../core/ports.js";
import { canonicalizeStudyNoteLinks, parseStudyNoteLinks, type StudyNoteLink } from "../core/study.js";
import {
  createBioObservationSchema,
  observationAsOfKey,
  observationHistory,
  observationsAsOf,
  liveOutEdgesAsOf,
  recordObservation,
  insertObservationIfSlotMax,
  monotonicRecordedAt,
  withSlotLock,
  type ObservationRow,
} from "../duckdb/observations.js";

// Retry ceiling for the monotonic compare-and-set under cross-process contention (each attempt re-reads the slot's
// latest and picks a strictly-later timestamp); bounded so pathological contention fails loudly, not forever.
const MEMORY_MAX_ATTEMPTS = 16;

// Memory unified INTO the temporal store: a memory note is observation(s) under the `memory:` namespace, so
// it gets modification history + as-of + cross-actor sharing for free — the same store as facts/compute, the
// unified-data-model bet. Content is a scalar observation; each [[to]]/typed link is an EDGE-like observation
// (object_id set) that materializeBioEdgesAsOf projects into a walkable graph AS OF t. A later human, model session,
// or automation can read what was already recorded. Files were last-write-wins with no history; the DB is
// append-only and never destroys a revision.
export const MEMORY_NS = "memory:";
const CONTENT = "has_content";
/** A sentinel far-future instant = "now / latest" for as-of reads (lexicographically sorts after any real ISO). */
export const MEMORY_NOW = "9999-12-31T23:59:59.999Z";

// Strict ISO-8601 / RFC3339 for an as-of instant (CAPTURING): date (Y-M-D), optionally time (T or space) + up to
// MILLISECOND fraction and a REQUIRED timezone (Z or ±hh:mm) WHEN a time is present. Rejects lenient forms ("March 1
// 2026") AND a tz-less datetime (JS Date.parse reads it as LOCAL, DuckDB TIMESTAMPTZ as the SESSION zone — divergent
// time-travel). Groups: 1=year 2=month 3=day 4=hour 5=min 6=sec.
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/;

/** Validate + normalize an as-of value to a CANONICAL UTC instant (used identically by the CLI and the Pi tools, so
 *  time-travel is host-independent). `undefined` → MEMORY_NOW (now/latest). A date-only value becomes UTC midnight; a
 *  tz-bearing time is converted to UTC. THROWS on an invalid/lenient/tz-less form so callers fail closed. */
export function normalizeAsOf(asOf: string | undefined): string {
  if (asOf === undefined || asOf === MEMORY_NOW) return MEMORY_NOW;
  const m = ISO_INSTANT_RE.exec(asOf);
  const invalid = (): never => { throw new Error(`--as-of '${asOf}' is not a valid ISO-8601 timestamp with a timezone when a time is given (e.g. 2026-01-01 or 2026-01-01T12:00:00Z)`); };
  if (!m) invalid();
  // Range + CALENDAR validation — the regex only checks shape, and Date.parse SILENTLY rolls over invalid calendar
  // dates (2026-02-31 -> Mar 3), which would give a wrong time-travel instant. Reject out-of-range fields.
  const [, y, mo, d, h, mi, s] = m!;
  const year = +y, month = +mo, day = +d;
  if (month < 1 || month > 12) invalid();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of THIS month (leap-aware)
  if (day < 1 || day > daysInMonth) invalid();
  if (h !== undefined && (+h > 23 || +mi > 59 || (s !== undefined && +s > 59))) invalid();
  const inst = new Date(asOf);
  if (Number.isNaN(inst.getTime())) invalid();
  return inst.toISOString();
}

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
  links?: StudyNoteLink[];
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
  // `remember` is a public SDK boundary, not only an internal target of `bio_remember`. Canonicalize before touching
  // DuckDB so JavaScript callers cannot persist one relation in content while the graph silently projects another.
  const links = canonicalizeStudyNoteLinks(note.links);
  await ensureMemorySchema(conn);
  const subject = memorySubjectId(note.slug);
  // LINEARIZABLE + serialized. withSlotLock(subject) serializes same-slug writes across ALL in-process connections
  // (keyed by statement_key, not by connection). Across PROCESSES (a shared ducknng server) that lock can't reach,
  // so the NOTE is written with the compare-and-set primitive: insertObservationIfSlotMax commits `now` only if it
  // is still the slot's strict max — one atomic statement, so on the server's serialized lane it can't tie with a
  // concurrent client; a concurrent advance fails the precondition and we re-read + retry with a later timestamp.
  // The note CAS is AUTO-COMMIT (not wrapped in a transaction): a surrounding transaction's snapshot would hide a
  // concurrent commit and defeat the guard. Edges/tombstones then write at the note's confirmed-unique `now`, so
  // they inherit a distinct timestamp and never tie either (they may briefly lag under cross-process contention, but
  // the latest note's revision always wins — the note is the linearization point).
  await withSlotLock(subject, async () => {
    for (let attempt = 0; attempt < MEMORY_MAX_ATTEMPTS; attempt++) {
      const now = await monotonicNow(conn, subject, wallNow); // strictly after the slug's current revision
      // `source` is the authoring actor. It is part of observation IDENTITY, so two actors remembering the same slug
      // are two attributed rows (both retained); the latest by recorded_at is "current" — you always know WHO said it.
      const { inserted } = await insertObservationIfSlotMax(conn, {
        statementKey: subject,
        subjectId: subject,
        predicate: CONTENT,
        value: { kind: note.kind, title: note.title, hook: note.hook, body: note.body, tags: note.tags, ...(links !== undefined ? { links } : {}), ...(note.sources && note.sources.length ? { sources: note.sources } : {}) },
        recordedAt: now,
        source: author,
      });
      if (!inserted) continue; // a concurrent client advanced the slot since we read it — re-read + retry
      const newKeys = new Set<string>();
      for (const link of parseStudyNoteLinks({ body: note.body, links })) {
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
      // ONLY reconcile MEMORY's own wikilink edges (statement_key `${subject}|<pred>|<to>`) — NOT every live edge out
      // of the subject: another subsystem may have recorded an unrelated edge fact from the same subject, and
      // tombstoning that here would be silent data loss.
      const memoryEdgePrefix = `${subject}|`;
      for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
        if (edge.statement_key.startsWith(memoryEdgePrefix) && !newKeys.has(edge.statement_key)) {
          await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
        }
      }
      return;
    }
    throw new Error(`remember: too many concurrent write conflicts on '${subject}' (${MEMORY_MAX_ATTEMPTS} attempts)`);
  });
}

function rowToContent(row: ObservationRow | null): RecalledMemory | null {
  if (!row || row.value_json == null) return null; // a tombstone (forgotten) carries null content
  const v = JSON.parse(row.value_json) as Omit<MemoryContent, "slug">;
  const links = canonicalizeStudyNoteLinks(v.links);
  return {
    slug: row.subject_id.slice(MEMORY_NS.length),
    kind: v.kind,
    title: v.title,
    hook: v.hook,
    body: v.body,
    tags: v.tags ?? [],
    ...(links !== undefined ? { links } : {}),
    ...(v.sources && v.sources.length ? { sources: v.sources } : {}),
    author: row.source ?? null,
  };
}

/** Recall a memory slug's content (and its author) AS OF a time (default now). null if it did not exist yet or was forgotten by then. */
export async function recall(conn: SqlConn, slug: string, asOf: string = MEMORY_NOW): Promise<RecalledMemory | null> {
  await ensureMemorySchema(conn); // a fresh/custom store may lack the table — recall of an empty store is null, not a throw
  return rowToContent(await observationAsOfKey(conn, memorySubjectId(slug), asOf));
}

/** The full revision trail of a slug (oldest-first) — surfaces WHAT changed, WHEN, and BY WHOM (a tombstone has null content). */
export async function memoryHistory(conn: SqlConn, slug: string): Promise<{ recordedAt: string; author: string | null; content: RecalledMemory | null }[]> {
  await ensureMemorySchema(conn); // fresh store -> empty history, not a missing-table throw
  const rows = await observationHistory(conn, memorySubjectId(slug));
  return rows.map((r) => ({ recordedAt: r.recorded_at, author: r.source ?? null, content: rowToContent(r) }));
}

/** List the memory slugs whose content is live AS OF a time (tombstoned slugs are excluded), each with its author. */
export async function listMemory(conn: SqlConn, asOf: string = MEMORY_NOW): Promise<RecalledMemory[]> {
  await ensureMemorySchema(conn); // fresh store -> empty list, not a missing-table throw
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
  // LINEARIZABLE + serialized (same reasoning as remember): withSlotLock serializes in-process; the TOMBSTONE is
  // written with the compare-and-set primitive so a concurrent client can't tie on recorded_at, and edge retractions
  // follow at the tombstone's confirmed-unique `now`.
  await withSlotLock(subject, async () => {
    for (let attempt = 0; attempt < MEMORY_MAX_ATTEMPTS; attempt++) {
      const now = await monotonicNow(conn, subject, wallNow); // strictly after the current content so a same-ms remember→forget deterministically forgets
      const { inserted } = await insertObservationIfSlotMax(conn, { statementKey: subject, subjectId: subject, predicate: CONTENT, recordedAt: now, source: author });
      if (!inserted) continue; // a concurrent client advanced the slot — re-read + retry
      // Also retract the note's OWN link edges (statement_key `${subject}|…`), otherwise they linger in
      // bio_edges_as_of as phantom edges out of a forgotten node. Only memory's wikilink edges, NOT an unrelated
      // subsystem's edge fact from the same subject (that would be silent data loss); same scoping as remember().
      const memoryEdgePrefix = `${subject}|`;
      for (const edge of await liveOutEdgesAsOf(conn, subject, MEMORY_NOW)) {
        if (edge.statement_key.startsWith(memoryEdgePrefix)) {
          await recordObservation(conn, { statementKey: edge.statement_key, subjectId: subject, predicate: edge.predicate, recordedAt: now, source: author });
        }
      }
      return;
    }
    throw new Error(`forget: too many concurrent write conflicts on '${subject}' (${MEMORY_MAX_ATTEMPTS} attempts)`);
  });
}
