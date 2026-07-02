import { createHash } from "node:crypto";
import type { SqlConn } from "../core/ports.js";
import { validateReadOnlySelect, assertSafeFixtureSql } from "../core/sql-guard.js";
import { recordObservation, observationAsOfKey } from "../duckdb/observations.js";
import { recordActivation } from "../duckdb/activation.js";

// Phase 4.3/4.4 — the GENERIC declare → validate → test → record → activate happy path. NOTHING here is shaped to a
// specific example (no coloc, no rare-high-impact): a candidate is just an operation spec + a fixture + an expected
// result — DATA. The substrate is the loop; the examples are interchangeable. The flow: validate the SQL is
// read-only, run it against the fixture in a SANDBOX, RECORD validation + test status as observations, and ACTIVATE
// only if BOTH pass AND an injected APPROVAL POLICY approves. "tests pass" never silently means "production
// activation" — the approval is the host/human boundary (the irreducible decision; the real workflow is the host's).
//   validate → test → record pass/fail → HOST APPROVAL POLICY → activate
//
// 4.4 makes the approval boundary DURABLE, not synchronous-only. The substrate does NOT own the approval workflow
// (RBAC, quorum, notifications, a task queue, an identity provider — all host-owned); it owns the ability to PARK a
// validated+tested candidate as `approval = "pending"` and RESUME the decision later (across a process restart or a
// human delay), because "pending" is just another temporal observation and "candidates awaiting approval as of t"
// is an as-of query. Two-phase: submitCandidateForApproval (park) → decideCandidateApproval (approve/reject +
// activate). runCandidateActivation stays as the synchronous convenience wrapper (no time gap → no `pending` row).

export interface OperationCandidate {
  id: string;
  version: string;
  /** DDL/DML that sets up the fixture table(s) in the sandbox (the candidate's declared test input). */
  fixtureSql: string;
  /** the candidate operation: a single read-only SELECT/WITH over the fixture (the candidate should ORDER BY). */
  sql: string;
  /** expected result rows, compared deep-equal to the candidate's output over the fixture. */
  expected: unknown[];
}

/** The host/human approval boundary — the irreducible decision. Return null to REJECT activation. */
export type ApprovalPolicy = (c: { id: string; version: string; specDigest: string }) => Promise<{ approvedBy: string; reason?: string } | null>;

export interface CandidateOutcome {
  specDigest: string;
  validation: "passed" | "failed";
  test: "passed" | "failed" | "skipped";
  activated: boolean;
}

/** The parked state of a validated+tested candidate (4.4). `pendingApproval` = both passed and it now awaits a decision. */
export interface SubmitOutcome {
  specDigest: string;
  validation: "passed" | "failed";
  test: "passed" | "failed" | "skipped";
  pendingApproval: boolean;
}

export interface ApprovalDecision {
  id: string;
  version: string;
  specDigest: string;
  approved: boolean;
  decidedAt: string;
  source: string;
  approvedBy?: string;
  reason?: string;
}

const ID = /^[A-Za-z0-9._-]+$/;
const specDigestOf = (c: OperationCandidate): string =>
  `sha256:${createHash("sha256").update(JSON.stringify([c.id, c.version, c.fixtureSql, c.sql, c.expected])).digest("hex")}`;
const parseStatus = (row: { value_json: string | null } | null): string | null => (row?.value_json != null ? JSON.parse(row.value_json) as string : null);

function assertIds(id: string, version: string): void {
  if (!ID.test(id ?? "")) throw new Error("harness: candidate.id must match [A-Za-z0-9._-]+"); // fail-fast (else it'd only fail at activate)
  if (!ID.test(version ?? "")) throw new Error("harness: candidate.version must match [A-Za-z0-9._-]+");
}

/** Record ONE candidate status slot (validation / fixture-test / approval) as a temporal observation. */
function recStatus(conn: SqlConn, specDigest: string, recordedAt: string, source: string, slot: string, predicate: string, value: string): Promise<string> {
  const candKey = `candidate:${specDigest}`;
  return recordObservation(conn, { statementKey: `${candKey}:${slot}`, subjectId: candKey, predicate, value, recordedAt, source, digest: specDigest });
}

/** validate (read-only) + test-against-fixture-in-sandbox, recording BOTH as observations. Shared by the durable
 *  (submit) and synchronous (runCandidateActivation) paths so they never diverge. */
async function validateAndTest(conn: SqlConn, candidate: OperationCandidate, deps: { sandbox: SqlConn; recordedAt: string; source: string }): Promise<{ specDigest: string; validation: "passed" | "failed"; test: "passed" | "failed" | "skipped" }> {
  assertIds(candidate.id, candidate.version);
  const specDigest = specDigestOf(candidate);
  // Record the tested IDENTITY under the specDigest. specDigest already binds [id, version, …] cryptographically,
  // but the decision path takes a caller-supplied id/version — pin the real one here so activation can verify it and
  // can never activate a DIFFERENT operation than the one validated+tested (see recordApprovalDecision).
  await recStatus(conn, specDigest, deps.recordedAt, deps.source, "identity", "harness:candidate_identity", `${candidate.id}@${candidate.version}`);

  // 1. VALIDATE — the candidate operation must be a single read-only SELECT/WITH (the existing statement guard)
  let validation: "passed" | "failed" = "passed";
  // the candidate query must be a single read-only SELECT/WITH, AND its fixture setup must not escape the sandbox
  // (no ATTACH/COPY/INSTALL/… before approval) — both are part of a VALID candidate, checked before any execution.
  try { validateReadOnlySelect(candidate.sql); assertSafeFixtureSql(candidate.fixtureSql); } catch { validation = "failed"; }
  await recStatus(conn, specDigest, deps.recordedAt, deps.source, "validation", "harness:validation_status", validation);

  // 2. TEST — run the candidate over its fixture in a SANDBOX (separate conn — can't touch the real db), compare.
  //    The audit trail is COMPLETE: a skipped test (validation failed) is recorded too, not just absent.
  let test: "passed" | "failed" | "skipped" = "skipped";
  if (validation === "passed") {
    test = "failed";
    try {
      await deps.sandbox.run(candidate.fixtureSql);
      const actual = await deps.sandbox.all<Record<string, unknown>>(candidate.sql);
      const canon = (rows: unknown): string => JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)); // DuckDB ints can be bigint
      test = canon(actual) === canon(candidate.expected) ? "passed" : "failed";
    } catch { test = "failed"; }
  }
  await recStatus(conn, specDigest, deps.recordedAt, deps.source, "fixture-test", "harness:test_status", test);
  return { specDigest, validation, test };
}

/** 4.4 phase 1 — validate + test + PARK: if both pass, record `approval = "pending"` so a later (possibly
 *  after-restart) decideCandidateApproval can resume. Returns the parked outcome; a failed candidate is not parked. */
export async function submitCandidateForApproval(conn: SqlConn, candidate: OperationCandidate, deps: { sandbox: SqlConn; recordedAt: string; source: string }): Promise<SubmitOutcome> {
  const { specDigest, validation, test } = await validateAndTest(conn, candidate, deps);
  const pendingApproval = validation === "passed" && test === "passed";
  if (pendingApproval) await recStatus(conn, specDigest, deps.recordedAt, deps.source, "approval", "harness:approval_status", "pending");
  return { specDigest, validation, test, pendingApproval };
}

/** INTERNAL — record the approved/rejected decision and (if approved) ACTIVATE. Fail closed if the candidate did
 *  not pass validation+test (or was never submitted), or if a TERMINAL decision already exists (no double-approve).
 *  Does NOT require a `pending` marker — the synchronous path (runCandidateActivation) has no time gap and records
 *  none. The PUBLIC durable decideCandidateApproval adds the `pending` requirement on top of this. */
async function recordApprovalDecision(conn: SqlConn, d: ApprovalDecision): Promise<{ activated: boolean }> {
  assertIds(d.id, d.version);
  if (!/^sha256:[0-9a-f]{64}$/.test(d.specDigest ?? "")) throw new Error("approval decision: specDigest must be sha256:<64 hex>");
  const candKey = `candidate:${d.specDigest}`;
  const validation = parseStatus(await observationAsOfKey(conn, `${candKey}:validation`, d.decidedAt));
  const test = parseStatus(await observationAsOfKey(conn, `${candKey}:fixture-test`, d.decidedAt));
  if (validation !== "passed" || test !== "passed") throw new Error(`approval decision: candidate ${d.specDigest} did not pass validation+test as of ${d.decidedAt} (or was never submitted) — cannot decide`);
  // BIND the activation to the TESTED identity: the specDigest commits to a specific id/version, so a decision that
  // supplies a DIFFERENT id/version (with a valid specDigest) must NOT activate that un-tested operation. Fail closed.
  const identity = parseStatus(await observationAsOfKey(conn, `${candKey}:identity`, d.decidedAt));
  if (identity !== `${d.id}@${d.version}`) throw new Error(`approval decision: id/version '${d.id}@${d.version}' does not match the validated+tested candidate behind specDigest ${d.specDigest} ('${identity ?? "none"}') — cannot activate an operation that was never tested`);
  const current = parseStatus(await observationAsOfKey(conn, `${candKey}:approval`, d.decidedAt));
  if (current === "approved" || current === "rejected") throw new Error(`approval decision: candidate ${d.specDigest} already ${current} — a decision is terminal`);

  await recStatus(conn, d.specDigest, d.decidedAt, d.source, "approval", "harness:approval_status", d.approved ? "approved" : "rejected");
  if (d.approved) {
    await recordActivation(conn, { kind: "operation", id: d.id, version: d.version, specDigest: d.specDigest, recordedAt: d.decidedAt, source: d.source, approvedBy: d.approvedBy, reason: d.reason });
    return { activated: true };
  }
  return { activated: false };
}

/** 4.4 phase 2 — DECIDE a SUBMITTED (parked) candidate: record approved/rejected and, if approved, ACTIVATE. This
 *  is the DURABLE public contract: the candidate MUST currently be `approval="pending"` (submitCandidateForApproval
 *  parked it), and `decidedAt` MUST be strictly after that pending row (the monotonic-per-slot rule). A candidate
 *  that was never submitted, already terminal, or not parked fails closed — deciding is only for parked candidates.
 *  (The synchronous runCandidateActivation does NOT go through here — it has no parked state; it uses the internal
 *  recordApprovalDecision directly.) */
export async function decideCandidateApproval(conn: SqlConn, d: ApprovalDecision): Promise<{ activated: boolean }> {
  assertIds(d.id, d.version);
  if (!/^sha256:[0-9a-f]{64}$/.test(d.specDigest ?? "")) throw new Error("decideCandidateApproval: specDigest must be sha256:<64 hex>");
  const pending = await observationAsOfKey(conn, `candidate:${d.specDigest}:approval`, d.decidedAt);
  const current = parseStatus(pending);
  if (current === "approved" || current === "rejected") throw new Error(`decideCandidateApproval: candidate ${d.specDigest} already ${current} — a decision is terminal`);
  if (current !== "pending") throw new Error(`decideCandidateApproval: candidate ${d.specDigest} is not awaiting approval (never submitted / not parked) — call submitCandidateForApproval first`);
  // compare as EPOCH, not raw strings: lexicographically '…00Z' > '…00.001Z' ('Z' > '.') though it is chronologically
  // BEFORE it, which would wrongly reject a valid sub-second-later decision.
  if (pending && Date.parse(pending.recorded_at) >= Date.parse(d.decidedAt)) throw new Error(`decideCandidateApproval: decidedAt (${d.decidedAt}) must be strictly after the pending submit (${pending.recorded_at})`);
  return recordApprovalDecision(conn, d);
}

/** Synchronous convenience wrapper (4.3): validate → test → (in-process) approve → activate, in one call. No time
 *  gap to bridge, so it records NO `pending` row — it composes validateAndTest with an immediate decide. */
export async function runCandidateActivation(
  conn: SqlConn,
  candidate: OperationCandidate,
  deps: { sandbox: SqlConn; recordedAt: string; source: string; approve: ApprovalPolicy },
): Promise<CandidateOutcome> {
  const { specDigest, validation, test } = await validateAndTest(conn, candidate, deps);
  let activated = false;
  if (validation === "passed" && test === "passed") {
    // ACTIVATE — only if the approval policy approves (the human/policy boundary, NOT "tests pass"). The decision is
    // recorded even when rejected, so a tested-but-rejected candidate is auditable.
    const approval = await deps.approve({ id: candidate.id, version: candidate.version, specDigest });
    // the synchronous path has no parked state — decide directly via the internal helper (public decide requires pending)
    ({ activated } = await recordApprovalDecision(conn, {
      id: candidate.id, version: candidate.version, specDigest, approved: approval !== null,
      decidedAt: deps.recordedAt, source: deps.source, approvedBy: approval?.approvedBy, reason: approval?.reason,
    }));
  }
  return { specDigest, validation, test, activated };
}
