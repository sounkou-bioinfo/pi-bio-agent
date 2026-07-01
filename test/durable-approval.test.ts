import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { activeOperationAsOf } from "../src/duckdb/activation.js";
import { submitCandidateForApproval, decideCandidateApproval, type OperationCandidate } from "../src/hosts/harness-adaptation.js";

// Phase 4.4: DURABLE, resumable approval. A candidate is PARKED (`approval = "pending"`) by submit, then DECIDED
// later (a distinct, strictly-later timestamp = a process restart / a human delay). The substrate owns only the
// park+resume state; RBAC/UI/notification stay the host's. Same GENERIC synthetic candidate as 4.3 (no bio shape).
const T1 = "2026-06-30T00:00:00Z"; // submit
const T2 = "2026-06-30T01:00:00Z"; // decide (strictly later — the monotonic-per-slot rule)

async function obsConn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}
const sandbox = async (): Promise<SqlConn> => duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
const status = async (c: SqlConn, key: string, t: string): Promise<string | null> => {
  const r = await observationAsOfKey(c, key, t);
  return r?.value_json != null ? JSON.parse(r.value_json) as string : null;
};

const good: OperationCandidate = {
  id: "double.report", version: "1.0.0",
  fixtureSql: "CREATE TABLE nums AS SELECT * FROM (VALUES (1),(2),(3)) AS v(x)",
  sql: "SELECT x, x*2 AS y FROM nums ORDER BY x",
  expected: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }],
};

describe("Phase 4.4: durable submit -> (park) -> decide approval", () => {
  test("submit parks a good candidate as pending; it is NOT active until decided", async () => {
    const conn = await obsConn();
    const out = await submitCandidateForApproval(conn, good, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    assert.deepEqual({ v: out.validation, t: out.test, p: out.pendingApproval }, { v: "passed", t: "passed", p: true });
    assert.equal(await status(conn, `candidate:${out.specDigest}:approval`, T1), "pending", "parked as pending");
    assert.equal(await activeOperationAsOf(conn, "double.report", T1), null, "pending != active");
  });

  test("decide(approved) at a LATER time activates; pending is superseded, active as-of the decision", async () => {
    const conn = await obsConn();
    const sub = await submitCandidateForApproval(conn, good, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    const dec = await decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: sub.specDigest, approved: true, decidedAt: T2, source: "approver:alice", approvedBy: "alice", reason: "looks right" });
    assert.equal(dec.activated, true);
    // as-of BEFORE the decision it was still pending + inactive; as-of the decision it is approved + active
    assert.equal(await status(conn, `candidate:${sub.specDigest}:approval`, T1), "pending");
    assert.equal(await activeOperationAsOf(conn, "double.report", T1), null);
    assert.equal(await status(conn, `candidate:${sub.specDigest}:approval`, T2), "approved");
    assert.equal((await activeOperationAsOf(conn, "double.report", T2))?.version, "1.0.0");
  });

  test("decide(rejected) records rejected and never activates", async () => {
    const conn = await obsConn();
    const sub = await submitCandidateForApproval(conn, good, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    const dec = await decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: sub.specDigest, approved: false, decidedAt: T2, source: "approver:bob", reason: "not now" });
    assert.equal(dec.activated, false);
    assert.equal(await status(conn, `candidate:${sub.specDigest}:approval`, T2), "rejected");
    assert.equal(await activeOperationAsOf(conn, "double.report", T2), null);
  });

  test("a candidate that FAILS validation is not parked, and cannot be decided", async () => {
    const conn = await obsConn();
    const writey: OperationCandidate = { ...good, sql: "DELETE FROM nums" };
    const sub = await submitCandidateForApproval(conn, writey, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    assert.deepEqual({ v: sub.validation, t: sub.test, p: sub.pendingApproval }, { v: "failed", t: "skipped", p: false });
    assert.equal(await status(conn, `candidate:${sub.specDigest}:approval`, T1), null, "not parked");
    await assert.rejects(() => decideCandidateApproval(conn, { id: writey.id, version: writey.version, specDigest: sub.specDigest, approved: true, decidedAt: T2, source: "x" }), /did not pass validation/);
  });

  test("deciding an unknown specDigest fails closed", async () => {
    const conn = await obsConn();
    const bogus = `sha256:${"0".repeat(64)}`;
    await assert.rejects(() => decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: bogus, approved: true, decidedAt: T2, source: "x" }), /did not pass validation|never submitted/);
  });

  test("a decision is TERMINAL — deciding twice fails closed (no double-approve)", async () => {
    const conn = await obsConn();
    const sub = await submitCandidateForApproval(conn, good, { sandbox: await sandbox(), recordedAt: T1, source: "ci" });
    await decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: sub.specDigest, approved: true, decidedAt: T2, source: "alice" });
    await assert.rejects(() => decideCandidateApproval(conn, { id: "double.report", version: "1.0.0", specDigest: sub.specDigest, approved: false, decidedAt: "2026-06-30T02:00:00Z", source: "bob" }), /already approved — a decision is terminal/);
  });
});
