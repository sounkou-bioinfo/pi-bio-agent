import type { SqlConn } from "../core/ports.js";
import { recordObservation, observationsAsOf } from "./observations.js";

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

/** Record an activation event (append-only). Returns the observation id. */
export async function recordActivation(conn: SqlConn, e: ActivationEventInput): Promise<string> {
  if (!e.id || !e.version || !e.specDigest || !e.recordedAt || !e.source) {
    throw new Error("recordActivation: id, version, specDigest, recordedAt, source are all required");
  }
  return recordObservation(conn, {
    statementKey: statementKey(e.id),
    subjectId: `operation:${e.id}`,
    predicate: "harness:active_version",
    objectId: `operation:${e.id}@${e.version}`,
    recordedAt: e.recordedAt,
    source: e.source,
    digest: e.specDigest, // the activated declaration's digest — part of identity (a different spec = a new event)
    attrs: { version: e.version, specDigest: e.specDigest, ...(e.reason ? { reason: e.reason } : {}), ...(e.approvedBy ? { approvedBy: e.approvedBy } : {}) },
    trust: { provenanceClass: "attested", producer: e.approvedBy ?? e.source }, // ATTESTED policy/human decision, not computed
  });
}

export interface ActiveOperation { operationId: string; version: string; specDigest: string; recordedAt: string; source: string; }

/** The operation's currently-active version as of time t — the latest activation event for its slot, or null. */
export async function activeOperationAsOf(conn: SqlConn, operationId: string, t: string): Promise<ActiveOperation | null> {
  const key = statementKey(operationId);
  const r = (await observationsAsOf(conn, t)).find((x) => x.statement_key === key);
  if (!r) return null;
  const a = (r.attrs ? JSON.parse(r.attrs) : {}) as { version?: string; specDigest?: string };
  return { operationId, version: a.version ?? "", specDigest: a.specDigest ?? r.digest ?? "", recordedAt: r.recorded_at, source: r.source ?? "" };
}

/** Roll back to a prior version — by APPENDING it again (never mutate). The caller passes the version to restore. */
export async function rollbackOperation(conn: SqlConn, e: ActivationEventInput): Promise<string> {
  return recordActivation(conn, { ...e, reason: e.reason ?? "rollback" });
}
