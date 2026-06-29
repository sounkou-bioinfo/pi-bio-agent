import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { sqlBlackboard } from "../src/hosts/sql-blackboard.js";
import type { SqlConn } from "../src/core/ports.js";
import type { StudyNote } from "../src/core/study.js";

// A real transport for the decentralized blackboard: a SQL table. Single-process here; a quack-attached conn
// makes the same code cross-process. Proves publish/await over the table, both orders, idempotency, and timeout.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
const note = (slug: string): StudyNote => ({ schema: "pi-bio.study_note.v1", slug, id: slug, kind: "memory_note", title: slug, hook: "h", body: `body-${slug}`, tags: [], sources: [], createdAt: "T", updatedAt: "T" });

describe("sql blackboard: a real (quack-attachable) transport for decentralized coordination", () => {
  test("publish then await returns the note; idempotent re-publish keeps the first", async () => {
    const bb = await sqlBlackboard(await memoryConn(), { pollMs: 5 });
    await bb.publish("a", note("a"));
    await bb.publish("a", { ...note("a"), body: "SHOULD BE IGNORED" }); // idempotent
    const got = await bb.awaitNote("a");
    assert.equal(got.body, "body-a");
  });

  test("await-before-publish blocks until the row appears (the subscribe semantics)", async () => {
    const bb = await sqlBlackboard(await memoryConn(), { pollMs: 5 });
    const pending = bb.awaitNote("later");
    setTimeout(() => { void bb.publish("later", note("later")); }, 30); // published after the await started
    const got = await pending;
    assert.equal(got.slug, "later");
  });

  test("awaitNote times out (fail closed) when nothing is ever published", async () => {
    const bb = await sqlBlackboard(await memoryConn(), { pollMs: 5, timeoutMs: 40 });
    await assert.rejects(() => bb.awaitNote("never"), /timed out/);
  });
});
