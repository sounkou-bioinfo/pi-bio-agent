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
 *  SERIALIZED. Cross-PROCESS writers already are — DuckDB's file lock is a cross-process exclusive writer (a second
 *  process can't open the store for write). Cross-HOST writes go through ducknng RPC, where the native-DuckDB server
 *  serializes them. The gap is IN-PROCESS: DuckDB does NOT exclude same-process opens (two `openBioStore` handles to
 *  one file coexist), so two concurrent callers could each read the slot's latest, both compute the same +1ms, and
 *  collide on the hash-arbitrary observation_id tiebreak. Callers that may issue concurrent same-slot writes in one
 *  process must serialize per statement_key (an in-process per-slot lock — the planned `recordMonotonicObservation`
 *  wrapper); the +1ms advance alone only disambiguates SEQUENTIAL writes a coarse clock stamped at the same ms. */
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
