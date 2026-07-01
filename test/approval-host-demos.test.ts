import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, recordObservation, observationsAsOf, observationAsOfKey } from "../src/duckdb/observations.js";
import { activeOperationAsOf } from "../src/duckdb/activation.js";
import { submitCandidateForApproval, decideCandidateApproval, runCandidateActivation, type ApprovalPolicy, type OperationCandidate } from "../src/hosts/harness-adaptation.js";

// The host-owned approval pieces — RBAC, quorum, notifications, a task queue, an identity provider, approval UX —
// are DELIBERATELY not in the substrate. This file DEMOS each one as a THIN ADAPTER over the substrate's approval
// seam (ApprovalPolicy + submit/decide + observation as-of), living in a TEST precisely because it is host code.
// The point is to CHECK THE GENERIC SHAPE: every pattern must sit on top with ZERO change to src/ — if one needed a
// core change, the shape would not be generic. (It doesn't: votes/queues/notifications are all just observations +
// queries, and the policy decision is the injected ApprovalPolicy.)
const T1 = "2026-06-30T00:00:00Z"; // submit
const T2 = "2026-06-30T01:00:00Z"; // decide
const T3 = "2026-06-30T02:00:00Z";

async function obsConn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}
const sandbox = async (): Promise<SqlConn> => duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());

const double: OperationCandidate = {
  id: "double.report", version: "1.0.0",
  fixtureSql: "CREATE TABLE nums AS SELECT * FROM (VALUES (1),(2),(3)) AS v(x)",
  sql: "SELECT x, x*2 AS y FROM nums ORDER BY x",
  expected: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }],
};
const triple: OperationCandidate = { ...double, id: "triple.report", sql: "SELECT x, x*3 AS y FROM nums ORDER BY x", expected: [{ x: 1, y: 3 }, { x: 2, y: 6 }, { x: 3, y: 9 }] };

describe("host-owned approval pieces as THIN ADAPTERS over the substrate (generic-shape check)", () => {
  // ── IDENTITY PROVIDER + RBAC: an ApprovalPolicy that resolves WHO is approving and gates by ROLE. ────────────
  test("identity + RBAC: only an approver holding the operation's role can activate; approvedBy is stamped", async () => {
    // a host RBAC table: user -> the operation roles they hold. The identity provider is just "who is this session".
    const roleGrants: Record<string, string[]> = { alice: ["approver:double.report"], bob: [] };
    const rbacPolicy = (session: string): ApprovalPolicy => async ({ id }) =>
      roleGrants[session]?.includes(`approver:${id}`) ? { approvedBy: `user:${session}`, reason: "rbac: role granted" } : null;

    const conn = await obsConn();
    // bob lacks the role -> rejected, not active
    const denied = await runCandidateActivation(conn, double, { sandbox: await sandbox(), recordedAt: T1, source: "ci", approve: rbacPolicy("bob") });
    assert.equal(denied.activated, false);
    assert.equal(await activeOperationAsOf(conn, "double.report", T1), null);

    // alice holds it -> activated, and the identity is stamped into the activation observation (attrs.approvedBy)
    const conn2 = await obsConn();
    const ok = await runCandidateActivation(conn2, double, { sandbox: await sandbox(), recordedAt: T1, source: "ci", approve: rbacPolicy("alice") });
    assert.equal(ok.activated, true);
    const act = await observationAsOfKey(conn2, "activation:operation:double.report", T1);
    assert.equal(JSON.parse(act!.attrs!).approvedBy, "user:alice", "the approving identity is auditable in the activation record");
  });

  // ── QUORUM: N distinct sign-offs before activation. The KEY genericity test — our decide is single-terminal, so
  //    a quorum host records each VOTE as its own observation (a distinct slot), COUNTS them, and calls decide once.
  test("quorum: votes accumulate as observations; decide fires only when the count is met — no substrate change", async () => {
    const conn = await obsConn();
    const sub = await submitCandidateForApproval(conn, double, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    const QUORUM = 2;

    const castVote = (voter: string, at: string): Promise<string> =>
      recordObservation(conn, { statementKey: `candidate:${sub.specDigest}:vote:${voter}`, subjectId: `candidate:${sub.specDigest}`, predicate: "approval:vote", value: "approve", recordedAt: at, source: `user:${voter}` });
    const approvals = async (t: string): Promise<number> =>
      (await observationsAsOf(conn, t)).filter((r) => r.statement_key.startsWith(`candidate:${sub.specDigest}:vote:`) && r.value_json != null && JSON.parse(r.value_json) === "approve").length;

    await castVote("alice", T1);
    assert.equal(await approvals(T2), 1, "below quorum");
    assert.equal(await activeOperationAsOf(conn, "double.report", T2), null, "one vote is not a quorum -> not active");

    await castVote("bob", T2);
    assert.equal(await approvals(T3), QUORUM, "quorum reached");
    // the host applies its policy (count >= QUORUM) and makes ONE terminal decision on the substrate
    const dec = await decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: sub.specDigest, approved: (await approvals(T3)) >= QUORUM, decidedAt: T3, source: "quorum:2-of-N" });
    assert.equal(dec.activated, true);
    assert.equal((await activeOperationAsOf(conn, "double.report", T3))?.version, "1.0.0");
  });

  // ── NOTIFICATIONS: emit when a candidate is parked awaiting approval. A thin sink after submit. ───────────────
  test("notifications: parking a candidate pushes a notification to a host sink", async () => {
    const conn = await obsConn();
    const outbox: string[] = [];
    const notify = (msg: string): void => { outbox.push(msg); };

    const sub = await submitCandidateForApproval(conn, double, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    if (sub.pendingApproval) notify(`APPROVAL NEEDED: ${double.id}@${double.version} (${sub.specDigest})`);
    assert.equal(outbox.length, 1);
    assert.match(outbox[0], /APPROVAL NEEDED: double\.report@1\.0\.0/);
  });

  // ── TASK QUEUE + APPROVAL UX: "candidates awaiting approval as-of t" is a plain as-of query; a tiny UX lists it
  //    and decides one. Deciding a candidate removes it from the queue (its approval slot is no longer "pending").
  test("task queue + UX: the pending queue is an as-of query; decide drains it", async () => {
    const conn = await obsConn();
    // a host "approval inbox": the subjects whose latest approval slot is still 'pending', as of t
    const pendingQueue = async (t: string): Promise<string[]> =>
      (await observationsAsOf(conn, t)).filter((r) => r.predicate === "harness:approval_status" && r.value_json != null && JSON.parse(r.value_json) === "pending").map((r) => r.subject_id).sort();

    const a = await submitCandidateForApproval(conn, double, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    const b = await submitCandidateForApproval(conn, triple, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    assert.deepEqual(await pendingQueue(T1), [`candidate:${a.specDigest}`, `candidate:${b.specDigest}`].sort(), "both parked candidates are in the inbox");

    // the UX: pick the first, approve it
    const [firstDigest] = (await pendingQueue(T1)).map((s) => s.replace("candidate:", ""));
    const picked = firstDigest === a.specDigest ? double : triple;
    await decideCandidateApproval(conn, { id: picked.id, version: picked.version, specDigest: firstDigest, approved: true, decidedAt: T2, source: "user:reviewer" });

    const remaining = await pendingQueue(T2);
    assert.equal(remaining.length, 1, "the decided candidate has drained from the queue");
    assert.ok(!remaining.includes(`candidate:${firstDigest}`));
  });
});
