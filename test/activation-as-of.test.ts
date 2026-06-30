import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema } from "../src/duckdb/observations.js";
import { recordActivation, activeOperationAsOf, rollbackOperation } from "../src/duckdb/activation.js";

// Phase 4.2: activate / rollback is just temporal observations. activate = append; rollback = append the old
// version; current = activeOperationAsOf(t). No mutable state. Deterministic — no CI/approval/validation yet.
const T1 = "2026-01-01T00:00:00Z", T2 = "2026-02-01T00:00:00Z", T3 = "2026-03-01T00:00:00Z";

async function conn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}

describe("Phase 4.2: activate / rollback as temporal observations", () => {
  test("activate v1 then v2; the active version is latest-as-of (object changes, statement_key supersedes)", async () => {
    const c = await conn();
    await recordActivation(c, { kind: "operation", id: "rhi.report", version: "1.0.0", specDigest: "sha256:v1", recordedAt: T1, source: "ci-1", approvedBy: "alice" });
    await recordActivation(c, { kind: "operation", id: "rhi.report", version: "2.0.0", specDigest: "sha256:v2", recordedAt: T2, source: "ci-2", approvedBy: "bob" });
    assert.equal((await activeOperationAsOf(c, "rhi.report", T1))?.version, "1.0.0", "as-of T1: v1 active");
    assert.equal((await activeOperationAsOf(c, "rhi.report", T2))?.version, "2.0.0", "as-of T2: v2 active");
    assert.equal(await activeOperationAsOf(c, "rhi.report", "2025-01-01T00:00:00Z"), null, "before any activation: none active");
  });

  test("rollback restores a prior version by APPENDING it (never mutates)", async () => {
    const c = await conn();
    await recordActivation(c, { kind: "operation", id: "op", version: "1", specDigest: "sha256:s1", recordedAt: T1, source: "r1" });
    await recordActivation(c, { kind: "operation", id: "op", version: "2", specDigest: "sha256:s2", recordedAt: T2, source: "r2" });
    await rollbackOperation(c, { kind: "operation", id: "op", version: "1", specDigest: "sha256:s1", recordedAt: T3, source: "r3" });
    assert.equal((await activeOperationAsOf(c, "op", T3))?.version, "1", "rolled back to v1 as-of T3");
    // all three events survive as an append-only audit log
    const [{ n }] = await c.all<{ n: number }>("SELECT count(*) AS n FROM bio_observations WHERE statement_key='activation:operation:op'");
    assert.equal(Number(n), 3, "three activation events (append-only, no mutation)");
  });

  test("a different operation's activations do not interfere", async () => {
    const c = await conn();
    await recordActivation(c, { kind: "operation", id: "opA", version: "1", specDigest: "sha256:a1", recordedAt: T1, source: "r" });
    await recordActivation(c, { kind: "operation", id: "opB", version: "9", specDigest: "sha256:b9", recordedAt: T2, source: "r" });
    assert.equal((await activeOperationAsOf(c, "opA", T3))?.version, "1");
    assert.equal((await activeOperationAsOf(c, "opB", T3))?.version, "9");
  });

  test("source + specDigest are preserved in the current activation", async () => {
    const c = await conn();
    await recordActivation(c, { kind: "operation", id: "op", version: "3.1", specDigest: "sha256:deadbeef", recordedAt: T1, source: "approval-run-42", approvedBy: "carol" });
    const cur = await activeOperationAsOf(c, "op", T1);
    assert.equal(cur?.specDigest, "sha256:deadbeef");
    assert.equal(cur?.source, "approval-run-42");
  });

  test("equal-timestamp activations resolve to exactly ONE current (deterministic, no double-active)", async () => {
    const c = await conn();
    // two competing activations at the SAME recordedAt — a misuse the helper tolerates deterministically
    await recordActivation(c, { kind: "operation", id: "op", version: "a", specDigest: "sha256:a", recordedAt: T1, source: "r1" });
    await recordActivation(c, { kind: "operation", id: "op", version: "b", specDigest: "sha256:b", recordedAt: T1, source: "r2" });
    const cur = await activeOperationAsOf(c, "op", T1);
    assert.ok(cur !== null, "a current activation exists");
    assert.ok(cur!.version === "a" || cur!.version === "b", "exactly one wins (the asOf tie-break is deterministic per run)");
    // both events are retained; only the as-of cardinality is one
    const [{ n }] = await c.all<{ n: number }>("SELECT count(*) AS n FROM bio_observations WHERE statement_key='activation:operation:op'");
    assert.equal(Number(n), 2);
  });
});
