import type { SqlConn } from "../core/ports.js";
import { recordObservation, observationAsOfKey } from "./observations.js";

const ID = /^[A-Za-z0-9._-]+$/; // no ':'/'@' — those build the statement_key / object_id and must stay unambiguous
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const FAR_FUTURE = "9999-12-31T23:59:59.999Z"; // sentinel for "the latest activation, regardless of asOf clock"

// Phase 4.2 — activate / rollback as TEMPORAL OBSERVATIONS. The doctrine, kept literal: activation is just another
// observation; rollback is just another append; current state is just asOf(t). NO mutable state, NO lifecycle
// framework — a thin typed wrapper over recordObservation. The `statement_key` is the per-operation activation
// SLOT, so a later activation supersedes the prior one even though the OBJECT (the active version) changes — which
// is exactly what statement_key was designed for ([[semantic-sql-graph-substrate]]). recordedAt MUST be strictly
// monotonic per operation (the asOf tie-break is deterministic-but-arbitrary on equal timestamps; see observations.ts).

export interface ActivationEventInput {
  kind: "operation"; // only operations in 4.2; CI/approval/validation/fixtures are 4.3/4.4
  id: string;
  version: string;
  specDigest: string;
  recordedAt: string;
  source: string;
  reason?: string;
  approvedBy?: string;
}

const statementKey = (id: string): string => `activation:operation:${id}`;
const objectId = (id: string, version: string): string => `operation:${id}@${version}`;

/** Record an activation event (append-only). Returns the observation id. Fail-closed on shape — this is a harness
 *  boundary. A COMPETING activation (different version/digest) at the SAME recordedAt is rejected (state changes
 *  must be strictly monotonic in time); an EXACT-same event stays idempotent. */
export async function recordActivation(conn: SqlConn, e: ActivationEventInput): Promise<string> {
  if (e.kind !== "operation") throw new Error("recordActivation: kind must be 'operation'");
  if (!ID.test(e.id ?? "")) throw new Error("recordActivation: id must match [A-Za-z0-9._-]+ (no ':'/'@')");
  if (!ID.test(e.version ?? "")) throw new Error("recordActivation: version must match [A-Za-z0-9._-]+");
  if (!SHA256.test(e.specDigest ?? "")) throw new Error("recordActivation: specDigest must be 'sha256:<64 hex>'");
  if (!e.recordedAt || !e.source) throw new Error("recordActivation: recordedAt and source are required");
  const obj = objectId(e.id, e.version);
  // STRICT MONOTONICITY (the doctrine at the top, now enforced): an activation must be recorded strictly AFTER the
  // current latest one. A BACKDATED recordedAt (earlier than the latest) would rewrite HISTORY between the two times
  // yet NOT become current (activeOperationAsOf(now) still returns the later one) — the API would report success for
  // a rollback that didn't take effect. Reject it. (An exact re-record at the same instant stays idempotent below.)
  const latest = await observationAsOfKey(conn, statementKey(e.id), FAR_FUTURE);
  if (latest && new Date(e.recordedAt).getTime() < new Date(latest.recorded_at).getTime()) {
    throw new Error(`recordActivation: recordedAt ${e.recordedAt} is BEFORE the current activation at ${latest.recorded_at} — an activation must be strictly monotonic (a backdated one would not become current)`);
  }
  // compare the instant as TIMESTAMPTZ, not raw TEXT: '…00Z' and '…00.000Z' are the SAME instant but differ as
  // strings, so a TEXT '=' would MISS a competing activation at that instant — two different active versions could
  // then be admitted for one time, and activeOperationAsOf's equal-timestamp tiebreak (observation_id) picks one
  // arbitrarily. The cast makes the monotonicity guard see the real collision.
  const sameTime = await conn.all<{ object_id: string | null; digest: string | null }>(
    "SELECT object_id, digest FROM bio_observations WHERE statement_key = ? AND recorded_at::TIMESTAMPTZ = ?::TIMESTAMPTZ", [statementKey(e.id), e.recordedAt],
  );
  if (sameTime.some((r) => r.object_id !== obj || r.digest !== e.specDigest)) {
    throw new Error(`recordActivation: a COMPETING activation for '${e.id}' already exists at ${e.recordedAt} — state changes must be monotonic in time`);
  }
  return recordObservation(conn, {
    statementKey: statementKey(e.id),
    subjectId: `operation:${e.id}`,
    predicate: "harness:active_version",
    objectId: obj, // the CANONICAL state (version is here, NOT trusted from attrs)
    recordedAt: e.recordedAt,
    source: e.source,
    digest: e.specDigest, // CANONICAL — part of identity (a different spec = a new event)
    attrs: { ...(e.reason ? { reason: e.reason } : {}), ...(e.approvedBy ? { approvedBy: e.approvedBy } : {}) }, // annotation only
    trust: { provenanceClass: "attested", producer: e.approvedBy ?? e.source }, // ATTESTED policy/human decision, not computed
  });
}

export interface ActiveOperation { operationId: string; version: string; specDigest: string; recordedAt: string; source: string; }

/** The operation's currently-active version as of time t — the latest activation event for its slot, or null.
 *  Derives state from the CANONICAL `object_id`/`digest` (a keyed lookup), not from `attrs`. */
export async function activeOperationAsOf(conn: SqlConn, operationId: string, t: string): Promise<ActiveOperation | null> {
  const r = await observationAsOfKey(conn, statementKey(operationId), t);
  if (!r || !r.object_id) return null;
  const version = r.object_id.slice(r.object_id.lastIndexOf("@") + 1); // operation:<id>@<version>
  return { operationId, version, specDigest: r.digest ?? "", recordedAt: r.recorded_at, source: r.source ?? "" };
}

/** Roll back to a prior version — by APPENDING it again (never mutate). The caller passes the version to restore. */
export async function rollbackOperation(conn: SqlConn, e: ActivationEventInput): Promise<string> {
  return recordActivation(conn, { ...e, reason: e.reason ?? "rollback" });
}
