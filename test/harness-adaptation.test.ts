import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { activeOperationAsOf } from "../src/duckdb/activation.js";
import { runCandidateActivation, type OperationCandidate, type ApprovalPolicy } from "../src/hosts/harness-adaptation.js";

// Phase 4.3: the GENERIC declare->validate->test->record->activate loop. The candidate is plain DATA — a trivial
// operation over a synthetic fixture, NOT a bio example (the substrate is the loop; examples are interchangeable).
const NOW = "2026-06-30T00:00:00Z";
const approveAlways: ApprovalPolicy = async () => ({ approvedBy: "policy:test-auto", reason: "test" });
const rejectAlways: ApprovalPolicy = async () => null;

async function obsConn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}
const sandbox = async (): Promise<SqlConn> => duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());

// a trivial, correct candidate: y = 2x over a 3-row fixture
const good: OperationCandidate = {
  id: "double.report", version: "1.0.0",
  fixtureSql: "CREATE TABLE nums AS SELECT * FROM (VALUES (1),(2),(3)) AS v(x)",
  sql: "SELECT x, x*2 AS y FROM nums ORDER BY x",
  expected: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 }],
};

describe("Phase 4.3: declare -> validate -> test -> record -> activate (generic, no bio example)", () => {
  test("a good candidate validates, tests, records both, and ACTIVATES (with approval)", async () => {
    const conn = await obsConn();
    const out = await runCandidateActivation(conn, good, { sandbox: await sandbox(), recordedAt: NOW, source: "ci-run-1", approve: approveAlways });
    assert.deepEqual({ v: out.validation, t: out.test, a: out.activated }, { v: "passed", t: "passed", a: true });
    // the validation + test facts are recorded
    const candKey = `candidate:${out.specDigest}`;
    assert.equal(JSON.parse((await observationAsOfKey(conn, `${candKey}:validation`, NOW))!.value_json!), "passed");
    assert.equal(JSON.parse((await observationAsOfKey(conn, `${candKey}:fixture-test`, NOW))!.value_json!), "passed");
    // and the operation is now active
    assert.equal((await activeOperationAsOf(conn, "double.report", NOW))?.version, "1.0.0");
  });

  test("a candidate whose TEST fails (wrong expected) records failed and does NOT activate", async () => {
    const conn = await obsConn();
    const buggy: OperationCandidate = { ...good, expected: [{ x: 1, y: 999 }] }; // wrong
    const out = await runCandidateActivation(conn, buggy, { sandbox: await sandbox(), recordedAt: NOW, source: "ci", approve: approveAlways });
    assert.deepEqual({ v: out.validation, t: out.test, a: out.activated }, { v: "passed", t: "failed", a: false });
    assert.equal(JSON.parse((await observationAsOfKey(conn, `candidate:${out.specDigest}:fixture-test`, NOW))!.value_json!), "failed");
    assert.equal(await activeOperationAsOf(conn, "double.report", NOW), null, "a failed test never activates");
  });

  test("a non-read-only candidate FAILS validation, the test is skipped, no activation", async () => {
    const conn = await obsConn();
    const writey: OperationCandidate = { ...good, sql: "DELETE FROM nums" };
    const out = await runCandidateActivation(conn, writey, { sandbox: await sandbox(), recordedAt: NOW, source: "ci", approve: approveAlways });
    assert.deepEqual({ v: out.validation, t: out.test, a: out.activated }, { v: "failed", t: "skipped", a: false });
    assert.equal(JSON.parse((await observationAsOfKey(conn, `candidate:${out.specDigest}:fixture-test`, NOW))!.value_json!), "skipped", "the skipped test is recorded too (complete audit trail)");
  });

  test("tests passing is NOT activation — a rejecting approval policy blocks it, and the rejection is recorded", async () => {
    const conn = await obsConn();
    const out = await runCandidateActivation(conn, good, { sandbox: await sandbox(), recordedAt: NOW, source: "ci", approve: rejectAlways });
    assert.deepEqual({ v: out.validation, t: out.test, a: out.activated }, { v: "passed", t: "passed", a: false });
    assert.equal(JSON.parse((await observationAsOfKey(conn, `candidate:${out.specDigest}:approval`, NOW))!.value_json!), "rejected", "the approval rejection is auditable");
    assert.equal(await activeOperationAsOf(conn, "double.report", NOW), null, "validated + tested but NOT approved -> not active");
  });

  test("fail-fast: a candidate with an ambiguous id is rejected before any recording", async () => {
    const conn = await obsConn();
    const sb = await sandbox();
    await assert.rejects(() => runCandidateActivation(conn, { ...good, id: "bad:id" }, { sandbox: sb, recordedAt: NOW, source: "ci", approve: approveAlways }), /candidate.id must match/);
  });
});
