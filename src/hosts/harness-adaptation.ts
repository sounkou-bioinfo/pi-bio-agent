import { createHash } from "node:crypto";
import type { SqlConn } from "../core/ports.js";
import { validateReadOnlySelect } from "../core/sql-guard.js";
import { recordObservation } from "../duckdb/observations.js";
import { recordActivation } from "../duckdb/activation.js";

// Phase 4.3 — the GENERIC declare → validate → test → record → activate happy path. NOTHING here is shaped to a
// specific example (no coloc, no rare-high-impact): a candidate is just an operation spec + a fixture + an expected
// result — DATA. The substrate is the loop; the examples are interchangeable. The flow: validate the SQL is
// read-only, run it against the fixture in a SANDBOX, RECORD validation + test status as observations, and ACTIVATE
// only if BOTH pass AND an injected APPROVAL POLICY approves. "tests pass" never silently means "production
// activation" — the approval is the host/human boundary (the irreducible decision; the real workflow is 4.4's).
//   validate → test → record pass/fail → HOST APPROVAL POLICY → activate

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

const specDigestOf = (c: OperationCandidate): string =>
  `sha256:${createHash("sha256").update(JSON.stringify([c.id, c.version, c.fixtureSql, c.sql, c.expected])).digest("hex")}`;

export async function runCandidateActivation(
  conn: SqlConn,
  candidate: OperationCandidate,
  deps: { sandbox: SqlConn; recordedAt: string; source: string; approve: ApprovalPolicy },
): Promise<CandidateOutcome> {
  const specDigest = specDigestOf(candidate);
  const candKey = `candidate:${specDigest}`;
  const recStatus = (slot: string, predicate: string, value: string): Promise<string> =>
    recordObservation(conn, { statementKey: `${candKey}:${slot}`, subjectId: candKey, predicate, value, recordedAt: deps.recordedAt, source: deps.source, digest: specDigest });

  // 1. VALIDATE — the candidate operation must be a single read-only SELECT/WITH (the existing statement guard)
  let validation: "passed" | "failed" = "passed";
  try { validateReadOnlySelect(candidate.sql); } catch { validation = "failed"; }
  await recStatus("validation", "harness:validation_status", validation);

  // 2. TEST — run the candidate over its fixture in a SANDBOX (separate conn — can't touch the real db), compare
  let test: "passed" | "failed" | "skipped" = "skipped";
  if (validation === "passed") {
    test = "failed";
    try {
      await deps.sandbox.run(candidate.fixtureSql);
      const actual = await deps.sandbox.all<Record<string, unknown>>(candidate.sql);
      const canon = (rows: unknown): string => JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)); // DuckDB ints can be bigint
      test = canon(actual) === canon(candidate.expected) ? "passed" : "failed";
    } catch { test = "failed"; }
    await recStatus("fixture-test", "harness:test_status", test);
  }

  // 3. ACTIVATE — only if BOTH pass AND the approval policy approves (the human/policy boundary, NOT "tests pass")
  let activated = false;
  if (validation === "passed" && test === "passed") {
    const approval = await deps.approve({ id: candidate.id, version: candidate.version, specDigest });
    if (approval) {
      await recordActivation(conn, { kind: "operation", id: candidate.id, version: candidate.version, specDigest, recordedAt: deps.recordedAt, source: deps.source, approvedBy: approval.approvedBy, reason: approval.reason });
      activated = true;
    }
  }
  return { specDigest, validation, test, activated };
}
