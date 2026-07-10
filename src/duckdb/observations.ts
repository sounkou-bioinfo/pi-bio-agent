import { createHash } from "node:crypto";
import type { SqlConn } from "../core/ports.js";
import type { TrustBlock } from "../core/knowledge-graph.js";
import { materializeEntailedEdges } from "./graph-closure.js";

// Phase 4.0 — the temporal provenance-statement store. `bio_edges` stays the ATEMPORAL, UNIQUE-per-triple
// compiled navigation graph (+ the closure source); `bio_observations` is the APPEND-ONLY temporal fact/event log
// the docs already name as the "true-on-date-X, superseded-by-Y" store. record = append; current = latest-per-
// `statement_key` as-of t; rollback = append a row pointing at an older version — EVENT SOURCING, not mutable
// state. A row is EDGE-LIKE (`object_id` set → projects into `bio_edges_as_of` for graph walks) or SCALAR (`value`
// set), because not every fact is a graph edge (a coloc PP.H4 is a value; "tissue colocalizes with locus" is an
// edge).
//
// `statement_key` IS LOAD-BEARING: "latest" is per state SLOT, not per triple. Activation changes the OBJECT
// (active_version v1 → v2); a coloc PP.H4 changes the VALUE. Partitioning supersession by (subject,predicate,
// object) would be wrong — so each row names the slot it supersedes, and as-of is latest-per-statement_key.

const TABLE = "bio_observations";
// Retry ceiling for the monotonic compare-and-set under cross-process contention (each attempt re-reads the slot's
// latest and picks a strictly-later timestamp). Bounded so pathological contention fails loudly, not forever.
const MONOTONIC_MAX_ATTEMPTS = 16;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface BioObservationInput {
  /** the state SLOT a later row supersedes (NOT the full triple) — e.g. `activation:operation:foo`,
   *  `coloc:locus1:Whole_Blood:PP.H4`, `variant:1-123-A-T:classification`. */
  statementKey: string;
  subjectId: string;
  predicate: string;
  /** edge-like target (a node/CURIE) — projects into `bio_edges_as_of`. Mutually expressive with `value`. */
  objectId?: string;
  /** scalar/computed target (e.g. a PP.H4 number) — JSON-encoded into `value_json`. */
  value?: unknown;
  recordedAt: string;
  validFrom?: string;
  validTo?: string;
  source?: string;
  digest?: string;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
  /** optional; else derived from the canonical SEMANTIC content (incl recordedAt). */
  observationId?: string;
}

export interface BioObservationLinkInput {
  /** Edge source node. The node namespace is caller-owned (`turn:…`, `run:…`, `job:…`, `workflow:…`). */
  subjectId: string;
  /** Edge predicate. Prefer stable domain verbs such as `calls`, `produces`, `part_of`, `parent_session`. */
  predicate: string;
  /** Edge target node. */
  objectId: string;
  recordedAt: string;
  source?: string;
  digest?: string;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
  /** Optional state slot. Defaults to the stable edge slot `subject:predicate:object`. */
  statementKey?: string;
  observationId?: string;
}

export async function createBioObservationSchema(conn: SqlConn, opts: { ifNotExists?: boolean } = {}): Promise<void> {
  const ine = opts.ifNotExists === false ? "" : "IF NOT EXISTS ";
  await conn.run(
    `CREATE TABLE ${ine}${TABLE} (` +
      "observation_id TEXT PRIMARY KEY, statement_key TEXT NOT NULL, " +
      "subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_id TEXT, value_json JSON, " +
      "recorded_at TEXT NOT NULL, valid_from TEXT, valid_to TEXT, " +
      "source TEXT, digest TEXT, attrs JSON, trust JSON)", // NO unique-per-triple: re-assertion = a new row
  );
  await conn.run(`CREATE INDEX ${ine}${TABLE}_key_time ON ${TABLE} (statement_key, recorded_at)`);
  await conn.run(`CREATE INDEX ${ine}${TABLE}_subj_pred ON ${TABLE} (subject_id, predicate)`);
  await conn.run(`CREATE INDEX ${ine}${TABLE}_object ON ${TABLE} (object_id)`);
}

function observationId(o: BioObservationInput): string {
  // identity = SEMANTIC content + time + PROVENANCE (source, digest). This is a PROVENANCE-statement store: a
  // different producing run (source) or a different result digest is a DISTINCT provenance event, even for the
  // same semantic state at the same time. An exact-same call is still idempotent (same id, ON CONFLICT DO
  // NOTHING); re-asserting at a new recorded_at, or from a new run, is a new row. statement_key (not the id) is
  // what controls current/as-of supersession, so this does not affect "latest-per-statement_key". (attrs/trust
  // stay out of identity — they annotate, not identify.)
  const canonical = JSON.stringify([o.statementKey, o.subjectId, o.predicate, o.objectId ?? null, o.value ?? null, o.recordedAt, o.validFrom ?? null, o.validTo ?? null, o.source ?? null, o.digest ?? null]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Append a time-stamped, content-addressed statement. Idempotent on the derived id (exact re-record = no-op). */
export async function recordObservation(conn: SqlConn, obs: BioObservationInput): Promise<string> {
  if (!obs.statementKey || !obs.subjectId || !obs.predicate || !obs.recordedAt) {
    throw new Error("recordObservation: statementKey, subjectId, predicate, recordedAt are all required");
  }
  // FAIL CLOSED on an unparseable time: every as-of/history query casts recorded_at/valid_from/valid_to to
  // TIMESTAMPTZ, so ONE bad row would make those whole-table scans throw and break UNRELATED reads. Validate with
  // DuckDB's OWN parser — the exact cast the reads use — not JS Date.parse (V8 accepts strings DuckDB rejects). A
  // NULL casts cleanly; anything that survives this cast is safe to read back.
  try {
    await conn.all(`SELECT ?::TIMESTAMPTZ, ?::TIMESTAMPTZ, ?::TIMESTAMPTZ`, [obs.recordedAt, obs.validFrom ?? null, obs.validTo ?? null]);
  } catch {
    throw new Error(`recordObservation: recordedAt='${obs.recordedAt}', validFrom='${obs.validFrom ?? ""}', validTo='${obs.validTo ?? ""}' — each must be a DuckDB-castable TIMESTAMPTZ (else it poisons as-of/history reads)`);
  }
  const id = obs.observationId ?? observationId(obs);
  await conn.run(
    `INSERT INTO ${TABLE} (observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at, valid_from, valid_to, source, digest, attrs, trust)
     VALUES (?, ?, ?, ?, ?, ?::JSON, ?, ?, ?, ?, ?, ?::JSON, ?::JSON) ON CONFLICT (observation_id) DO NOTHING`,
    [id, obs.statementKey, obs.subjectId, obs.predicate, obs.objectId ?? null,
      obs.value === undefined ? null : JSON.stringify(obs.value), obs.recordedAt, obs.validFrom ?? null, obs.validTo ?? null,
      obs.source ?? null, obs.digest ?? null, obs.attrs ? JSON.stringify(obs.attrs) : null, obs.trust ? JSON.stringify(obs.trust) : null],
  );
  return id;
}

/** Append many independent observations with the same semantics as `recordObservation`, using two DuckDB calls
 * per batch (timestamp validation + insert) instead of two calls per row. This is the ingestion path for session
 * traces and other already-normalized statement streams; callers that need per-slot compare-and-set semantics must
 * continue to use `recordMonotonicObservation` / `insertObservationIfSlotMax`. */
export async function recordObservationBatch(conn: SqlConn, observations: readonly BioObservationInput[]): Promise<string[]> {
  if (observations.length === 0) return [];
  const rows = observations.map((obs, index) => {
    if (!obs.statementKey || !obs.subjectId || !obs.predicate || !obs.recordedAt) {
      throw new Error(`recordObservationBatch: row ${index} requires statementKey, subjectId, predicate, and recordedAt`);
    }
    return {
      observation_id: obs.observationId ?? observationId(obs),
      statement_key: obs.statementKey,
      subject_id: obs.subjectId,
      predicate: obs.predicate,
      object_id: obs.objectId ?? null,
      value_json: obs.value === undefined ? null : JSON.stringify(obs.value),
      recorded_at: obs.recordedAt,
      valid_from: obs.validFrom ?? null,
      valid_to: obs.validTo ?? null,
      source: obs.source ?? null,
      digest: obs.digest ?? null,
      attrs_json: obs.attrs ? JSON.stringify(obs.attrs) : null,
      trust_json: obs.trust ? JSON.stringify(obs.trust) : null,
    };
  });
  const encoded = JSON.stringify(rows);
  const invalid = await conn.all<{ row_index: string; recorded_at: string | null; valid_from: string | null; valid_to: string | null }>(
    `SELECT key AS row_index,
            json_extract_string(value, '$.recorded_at') AS recorded_at,
            json_extract_string(value, '$.valid_from') AS valid_from,
            json_extract_string(value, '$.valid_to') AS valid_to
     FROM json_each(?::JSON)
     WHERE try_cast(json_extract_string(value, '$.recorded_at') AS TIMESTAMPTZ) IS NULL
        OR (json_extract_string(value, '$.valid_from') IS NOT NULL AND try_cast(json_extract_string(value, '$.valid_from') AS TIMESTAMPTZ) IS NULL)
        OR (json_extract_string(value, '$.valid_to') IS NOT NULL AND try_cast(json_extract_string(value, '$.valid_to') AS TIMESTAMPTZ) IS NULL)
     LIMIT 1`,
    [encoded],
  );
  if (invalid[0]) {
    const bad = invalid[0];
    throw new Error(`recordObservationBatch: row ${bad.row_index} has a non-DuckDB-castable TIMESTAMPTZ (recordedAt='${bad.recorded_at ?? ""}', validFrom='${bad.valid_from ?? ""}', validTo='${bad.valid_to ?? ""}')`);
  }
  await conn.run(
    `INSERT INTO ${TABLE} (observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at, valid_from, valid_to, source, digest, attrs, trust)
     SELECT json_extract_string(value, '$.observation_id'),
            json_extract_string(value, '$.statement_key'),
            json_extract_string(value, '$.subject_id'),
            json_extract_string(value, '$.predicate'),
            json_extract_string(value, '$.object_id'),
            json_extract_string(value, '$.value_json')::JSON,
            json_extract_string(value, '$.recorded_at'),
            json_extract_string(value, '$.valid_from'),
            json_extract_string(value, '$.valid_to'),
            json_extract_string(value, '$.source'),
            json_extract_string(value, '$.digest'),
            json_extract_string(value, '$.attrs_json')::JSON,
            json_extract_string(value, '$.trust_json')::JSON
     FROM json_each(?::JSON)
     ON CONFLICT (observation_id) DO NOTHING`,
    [encoded],
  );
  return rows.map((row) => row.observation_id);
}

/** Record a graph edge in the temporal observation ledger. This is only a typed convenience over
 * `recordObservation(... objectId ...)`, but it is the shared primitive for stitching sessions, turns, tool calls,
 * scientific runs, jobs, workflow steps, artifacts, and caller-owned workflow nodes into one trace graph. */
export async function recordObservationLink(conn: SqlConn, link: BioObservationLinkInput): Promise<string> {
  if (!link.subjectId || !link.predicate || !link.objectId) {
    throw new Error("recordObservationLink: subjectId, predicate, and objectId are required");
  }
  return recordObservation(conn, {
    statementKey: link.statementKey ?? `${link.subjectId}:${link.predicate}:${link.objectId}`,
    subjectId: link.subjectId,
    predicate: link.predicate,
    objectId: link.objectId,
    recordedAt: link.recordedAt,
    source: link.source,
    digest: link.digest,
    attrs: link.attrs,
    trust: link.trust,
    observationId: link.observationId,
  });
}

/**
 * COMPARE-AND-SET insert: record `obs` (which carries an explicit `recordedAt`) ONLY IF that timestamp is still
 * strictly the maximum for its `statement_key` — i.e. no row for the slot exists at `recorded_at >= obs.recordedAt`.
 * Returns true if the row was inserted, false if the precondition failed (a concurrent writer already advanced the
 * slot to/at-or-past that instant). The whole check-and-insert is ONE statement, so on a serialized DuckDB lane —
 * including a shared ducknng RPC server, which processes each statement atomically — it is the atomic primitive that
 * makes a monotonic read-modify-write LINEARIZABLE across processes, where an in-process lock cannot reach.
 * Returns `{ id, inserted }`.
 */
export async function insertObservationIfSlotMax(conn: SqlConn, obs: BioObservationInput): Promise<{ id: string; inserted: boolean }> {
  if (!obs.statementKey || !obs.subjectId || !obs.predicate || !obs.recordedAt) {
    throw new Error("insertObservationIfSlotMax: statementKey, subjectId, predicate, recordedAt are all required");
  }
  try {
    await conn.all(`SELECT ?::TIMESTAMPTZ, ?::TIMESTAMPTZ, ?::TIMESTAMPTZ`, [obs.recordedAt, obs.validFrom ?? null, obs.validTo ?? null]);
  } catch {
    throw new Error(`insertObservationIfSlotMax: recordedAt='${obs.recordedAt}' must be a DuckDB-castable TIMESTAMPTZ`);
  }
  const id = obs.observationId ?? observationId(obs);
  const rows = await conn.all<{ observation_id: string }>(
    `INSERT INTO ${TABLE} (observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at, valid_from, valid_to, source, digest, attrs, trust)
     SELECT ?, ?, ?, ?, ?, ?::JSON, ?, ?, ?, ?, ?, ?::JSON, ?::JSON
     WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE statement_key = ? AND recorded_at::TIMESTAMPTZ >= ?::TIMESTAMPTZ)
     RETURNING observation_id`,
    [id, obs.statementKey, obs.subjectId, obs.predicate, obs.objectId ?? null,
      obs.value === undefined ? null : JSON.stringify(obs.value), obs.recordedAt, obs.validFrom ?? null, obs.validTo ?? null,
      obs.source ?? null, obs.digest ?? null, obs.attrs ? JSON.stringify(obs.attrs) : null, obs.trust ? JSON.stringify(obs.trust) : null,
      obs.statementKey, obs.recordedAt],
  );
  return { id, inserted: rows.length > 0 };
}

export interface ObservationRow {
  observation_id: string; statement_key: string; subject_id: string; predicate: string;
  object_id: string | null; value_json: string | null; recorded_at: string; valid_from: string | null; valid_to: string | null;
  source: string | null; digest: string | null; attrs: string | null; trust: string | null;
}

// latest row PER statement_key, as of time t (recorded_at <= t, valid interval [valid_from, valid_to) contains t).
// TIE-BREAK: two rows with the SAME statement_key and SAME recorded_at are ordered by observation_id DESC —
// deterministic but arbitrary. Producers that mutate STATE (e.g. activation) must use a strictly MONOTONIC
// recordedAt per state change, so "current" is never ambiguous; equal-timestamp rows for one slot should be exact
// provenance duplicates of the same state, never competing state changes.
const asOfSql = (table: string): string =>
  // compare/ORDER as TIMESTAMPTZ, not TEXT: lexicographic sort mis-orders mixed valid ISO forms ('…01Z' vs
   // '…01.999Z'), which would return the wrong current row / admit a backdated one. DuckDB parses both forms.
   `WITH eligible AS (
     SELECT * FROM ${table} WHERE recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ) AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
   ), ranked AS (
     SELECT *, row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn FROM eligible
   )
   SELECT * FROM ranked WHERE rn = 1`;

export async function observationsAsOf(conn: SqlConn, t: string): Promise<ObservationRow[]> {
  return conn.all<ObservationRow>(asOfSql(TABLE), [t, t, t]);
}

/** Every revision of ONE slot, oldest-first — the CHANGE HISTORY (what a memory/audit view surfaces). Unlike
 *  observationAsOfKey (latest as-of), this returns the whole append-only trail so callers can show what changed. */
export async function observationHistory(conn: SqlConn, statementKey: string): Promise<ObservationRow[]> {
  return conn.all<ObservationRow>(
    `SELECT * FROM ${TABLE} WHERE statement_key = ? ORDER BY recorded_at::TIMESTAMPTZ ASC, observation_id ASC`,
    [statementKey],
  );
}

/** The live EDGE statements (object_id set, latest-as-of, not tombstoned) OUT of one subject — keyed on the
 *  `(subject_id, predicate)` index, so it does NOT scan the whole table (what memory-link reconciliation wants). */
export async function liveOutEdgesAsOf(conn: SqlConn, subjectId: string, t: string): Promise<{ statement_key: string; predicate: string }[]> {
  return conn.all<{ statement_key: string; predicate: string }>(
    `SELECT statement_key, predicate FROM (
       SELECT statement_key, predicate, object_id,
              row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
       FROM ${TABLE}
       WHERE subject_id = ? AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ) AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
     ) WHERE rn = 1 AND object_id IS NOT NULL`,
    [subjectId, t, t, t],
  );
}

/** The latest-as-of, non-tombstoned `value_json` for EVERY slot whose statement_key starts with the literal
 *  `prefix` (e.g. "run:"). Used by GC to root CAS bytes from LIVE ledger facts: a `run:<id>` fact outlives the
 *  run directory (Datomic model — files become optional serialize, the fact is the durable digest reference), so
 *  its referenced bytes must be retained as long as the fact is live. `prefix` is a LITERAL (no LIKE wildcards). */
export async function latestValuesByPrefix(conn: SqlConn, prefix: string, t: string): Promise<string[]> {
  const rows = await conn.all<{ value_json: string | null }>(
    `SELECT value_json FROM (
       SELECT statement_key, value_json,
              row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
       FROM ${TABLE}
       WHERE starts_with(statement_key, ?) AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ) AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
     ) WHERE rn = 1 AND value_json IS NOT NULL`,
    [prefix, t, t, t],
  );
  return rows.map((r) => r.value_json).filter((v): v is string => v != null);
}

/** The single latest statement for ONE slot as of t — keyed, no full-table scan (what a state machine wants). */
export async function observationAsOfKey(conn: SqlConn, statementKey: string, t: string): Promise<ObservationRow | null> {
  const rows = await conn.all<ObservationRow>(
    `SELECT * FROM ${TABLE} WHERE statement_key = ? AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ) AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
     ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC LIMIT 1`,
    [statementKey, t, t, t],
  );
  return rows[0] ?? null;
}

/** For a STATE-MACHINE slot (a slug's current value — memory notes, skills): advance `now` to strictly AFTER the
 *  slot's current latest revision so "latest wins" is deterministic even when two writes collide in one millisecond
 *  (the equal-timestamp tiebreak is hash-arbitrary observation_id). Also fail closed if the write would land at/after
 *  the reserved far-future `sentinel` (default as-of reads use it, so a write there is invisible / can overflow the
 *  year on the +1ms advance). Append-only history is preserved — the advance only nudges a colliding write 1ms.
 *
 *  ATOMICITY / CONCURRENCY: this is a read-then-write, so it is deterministic only when writes to a given slot are
 *  SERIALIZED. Separate PROCESSES on a local file store already are — DuckDB's file lock is a cross-process exclusive
 *  writer (only one process writes at a time). Two gaps remain: (a) IN-PROCESS, DuckDB does NOT exclude same-process
 *  opens (two `openBioStore` handles to one file coexist), so two concurrent callers could each read the slot's
 *  latest, both compute the same +1ms, and collide on the hash-arbitrary observation_id tiebreak — closed by
 *  `recordMonotonicObservation` (below), which advances + writes under an in-process per-slot lock. (b) Concurrent
 *  CLIENTS of a SHARED server-backed store (ducknng RPC) are NOT closed by (a): the server runs each statement
 *  atomically but not the read-then-write PAIR, so two clients can still read the same latest and collide. That needs
 *  a server-side atomic advance+insert (one upsert) or a SERIALIZABLE txn — a real distributed-consistency piece, not
 *  yet built; the +1ms advance alone only disambiguates SEQUENTIAL writes a coarse clock stamped at the same ms. */
export async function monotonicRecordedAt(conn: SqlConn, statementKey: string, now: string, sentinel: string): Promise<string> {
  const latest = await observationAsOfKey(conn, statementKey, sentinel);
  const latestMs = latest ? Date.parse(latest.recorded_at) : NaN;
  const nowMs = Date.parse(now);
  const base = latest && Number.isFinite(latestMs) && Number.isFinite(nowMs) && nowMs <= latestMs ? new Date(latestMs + 1).toISOString() : now;
  if (!Number.isFinite(Date.parse(base)) || Date.parse(base) >= Date.parse(sentinel)) {
    throw new Error(`recordedAt '${base}' must be a real timestamp strictly before the reserved sentinel (${sentinel})`);
  }
  return base;
}

// In-process per-statement_key write serialization (see monotonicRecordedAt's CONCURRENCY note). Two `openBioStore`
// handles to ONE file coexist in a single process (DuckDB's exclusive-writer lock is cross-PROCESS only), so without
// this two concurrent callers could each read a slot's latest, both compute the same +1ms, and collide on the
// hash-arbitrary observation_id tiebreak. Keyed by statement_key: same-slot writes chain (serialize); different slots
// run in parallel. A rejected write does NOT poison the chain (the tail is normalized to a settled promise), and the
// map entry is GC'd when the slot goes idle so it can't grow unbounded. SCOPE: this covers same-process writers and
// separate PROCESSES on a local file store (DuckDB's cross-process exclusive-writer lock means only one writes at a
// time). It does NOT cover concurrent CLIENTS of a SHARED server-backed store (ducknng RPC): the server executes each
// statement atomically but NOT the read-then-write PAIR, so two clients can still read the same latest and collide —
// closing that needs a server-side atomic advance+insert (a single upsert) or a SERIALIZABLE txn (see the note above).
const slotWriteChains = new Map<string, Promise<void>>();
/** Serialize `fn` against other calls with the SAME `statementKey` in this process (different keys run in parallel).
 *  For a MULTI-write state transition (e.g. memory remember/forget writes content + link edges + tombstones as one
 *  revision) wrap the whole body so a concurrent same-slot writer can't interleave. Do NOT nest a same-key
 *  recordMonotonicObservation inside — it re-acquires this lock and would deadlock; call recordObservation directly. */
export async function withSlotLock<T>(statementKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = slotWriteChains.get(statementKey) ?? Promise.resolve();
  const curr = prev.then(fn, fn); // run after the prior write settles, regardless of its outcome
  const tail = curr.then(() => {}, () => {}); // normalized settled tail so one failure can't break the chain
  slotWriteChains.set(statementKey, tail);
  try {
    return await curr;
  } finally {
    if (slotWriteChains.get(statementKey) === tail) slotWriteChains.delete(statementKey); // GC when we were the last in line
  }
}

// Per-CONNECTION transaction serialization. DuckDB allows only ONE active transaction per connection, so two
// overlapping BEGINs on one connection throw; this WeakMap chain guarantees transactions on a given connection run
// one at a time. Keyed by the connection object so distinct connections transact in parallel.
const connTxnChains = new WeakMap<object, Promise<void>>();
/** Run `fn` as a single DuckDB transaction (BEGIN → COMMIT; ROLLBACK on throw), serialized per connection. Use for a
 *  MULTI-STATEMENT state transition that must be ALL-OR-NOTHING (memory remember/forget: content + link edges +
 *  tombstones) — a mid-way insert failure then rolls the whole revision back instead of leaving partial edges.
 *  CONTRACT: while this transaction is open the connection must NOT be used by ANOTHER concurrent writer, or that
 *  write joins (and can be rolled back with) this txn. The extension opens a FRESH connection per op, which
 *  satisfies it; a caller that shares one connection across concurrent subsystems must serialize them itself. */
export async function inTransaction<T>(conn: SqlConn, fn: () => Promise<T>): Promise<T> {
  const key = conn as unknown as object;
  const prev = connTxnChains.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    await conn.run("BEGIN TRANSACTION");
    try {
      const r = await fn();
      await conn.run("COMMIT");
      return r;
    } catch (e) {
      try { await conn.run("ROLLBACK"); } catch { /* surface the ORIGINAL error, not a rollback failure */ }
      throw e;
    }
  });
  const tail = run.then(() => {}, () => {}); // normalized settled tail so one failure doesn't break the chain
  connTxnChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (connTxnChains.get(key) === tail) connTxnChains.delete(key); // GC when idle
  }
}

/** Record a STATE-MACHINE observation whose `recordedAt` must strictly-monotonically supersede the slot's latest —
 *  the atomic read-then-write that memory/skill/action-cache/run:<id> writers need. Serializes per statement_key in
 *  this process (concurrent same-slot writers can't race the +1ms advance) and returns the observation id. `sentinel`
 *  is the slot's reserved far-future bound (writes at/after it fail closed). The caller passes the observation WITHOUT
 *  `recordedAt`; this computes it under the lock. */
export async function recordMonotonicObservation(conn: SqlConn, obs: Omit<BioObservationInput, "recordedAt">, now: string, sentinel: string): Promise<string> {
  // withSlotLock serializes same-slot writers WITHIN this process (so the +1ms advance can't race between two
  // in-process connections); the guarded compare-and-set insert then makes the advance atomic at the DATABASE, so
  // the read-modify-write is LINEARIZABLE even across PROCESSES (a shared ducknng RPC server) where the lock can't
  // reach. In-process the lock means the CAS precondition never fails (one attempt); across processes a concurrent
  // advance fails the precondition and we re-read + retry with a strictly-later timestamp.
  return withSlotLock(obs.statementKey, async () => {
    for (let attempt = 0; attempt < MONOTONIC_MAX_ATTEMPTS; attempt++) {
      const at = await monotonicRecordedAt(conn, obs.statementKey, now, sentinel);
      const { id, inserted } = await insertObservationIfSlotMax(conn, { ...obs, recordedAt: at });
      if (inserted) return id;
      // Precondition failed: EITHER this exact observation already exists (idempotent no-op → return it), OR a
      // concurrent writer advanced the slot past `at` (re-read the new latest and retry with a later timestamp).
      const dup = await conn.all(`SELECT 1 FROM ${TABLE} WHERE observation_id = ? LIMIT 1`, [id]);
      if (dup.length > 0) return id;
    }
    throw new Error(`recordMonotonicObservation: too many concurrent write conflicts on '${obs.statementKey}' (${MONOTONIC_MAX_ATTEMPTS} attempts)`);
  });
}

/** Project the EDGE-LIKE latest-as-of statements (`object_id` set) into a `bio_edges`-shaped table, so the SAME
 *  SemanticSQL closure (`materializeEntailedEdges` with a source table) walks the graph as it stood at time t.
 *  Returns the projected edge count. */
export async function materializeBioEdgesAsOf(conn: SqlConn, t: string, target = "bio_edges_as_of"): Promise<number> {
  if (!IDENT.test(target)) throw new Error(`materializeBioEdgesAsOf: target '${target}' must be a SQL identifier`);
  await conn.run(
    // keep the PROVENANCE columns in the projection so bio_edges_as_of is an auditable graph table, not only a
    // closure input (materializeEntailedEdges reads just from_id/predicate/to_id, so the extra columns are free).
    `CREATE OR REPLACE TABLE ${target} AS
     SELECT subject_id AS from_id, object_id AS to_id, predicate, attrs, trust,
            observation_id, statement_key, recorded_at, source, digest
     FROM (${asOfSql(TABLE)}) WHERE object_id IS NOT NULL`,
    [t, t, t],
  );
  const [row] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${target}`);
  return Number(row?.n ?? 0);
}

/** Convenience: project as-of edges AND close them — `entailed_edge_as_of` walks the graph as of time t. */
export async function entailedEdgesAsOf(conn: SqlConn, t: string, transitivePredicates: readonly string[]): Promise<number> {
  await materializeBioEdgesAsOf(conn, t, "bio_edges_as_of");
  return materializeEntailedEdges(conn, transitivePredicates, { sourceTable: "bio_edges_as_of", targetTable: "entailed_edge_as_of" });
}
