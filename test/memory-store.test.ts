import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { forget, listMemory, memoryHistory, memorySubjectId, recall, remember, MEMORY_NOW } from "../src/hosts/memory-store.js";
import { materializeBioEdgesAsOf } from "../src/duckdb/observations.js";

const conn = async (): Promise<SqlConn> => duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
const note = (slug: string, body: string) => ({ slug, kind: "memory_note", title: slug, hook: `hook ${slug}`, body, tags: [] });

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:00:01Z";
const T2 = "2026-01-01T00:00:02Z";

// Memory unified into the temporal store: history + as-of + retraction, the same store as facts.
describe("temporal memory over bio_observations", () => {
  test("an edit supersedes 'now' but the prior revision survives as-of", async () => {
    const c = await conn();
    await remember(c, note("acmg", "v1 body"), T1);
    await remember(c, note("acmg", "v2 body"), T2);
    assert.equal((await recall(c, "acmg"))?.body, "v2 body"); // now = latest
    assert.equal((await recall(c, "acmg", T1))?.body, "v1 body"); // as-of t1 = the old revision
    assert.equal(await recall(c, "acmg", T0), null); // before it existed
  });

  test("history surfaces every revision, oldest-first", async () => {
    const c = await conn();
    await remember(c, note("x", "one"), T1);
    await remember(c, note("x", "two"), T2);
    assert.deepEqual((await memoryHistory(c, "x")).map((r) => r.content?.body), ["one", "two"]);
  });

  test("forget is a temporal RETRACTION: gone now, still visible as-of earlier", async () => {
    const c = await conn();
    await remember(c, note("temp", "scratch"), T1);
    await forget(c, "temp", T2);
    assert.equal(await recall(c, "temp"), null); // forgotten as of now
    assert.equal((await recall(c, "temp", T1))?.body, "scratch"); // history intact
    assert.deepEqual((await listMemory(c)).map((m) => m.slug), []); // excluded from the current list
    assert.deepEqual((await listMemory(c, T1)).map((m) => m.slug), ["temp"]); // present as of t1
  });

  test("same-millisecond remember→forget deterministically FORGETS (monotonic recordedAt, not hash-arbitrary)", async () => {
    // Two rapid tool calls can share a systemClock() millisecond. The observation store's equal-timestamp tiebreak
    // is hash-arbitrary, so without a monotonic clock the winner would be random. The memory store advances the
    // second write to strictly after the first, so the LATER operation wins — every time.
    const c = await conn();
    const SAME = "2026-01-01T00:00:03Z";
    await remember(c, note("flip", "content"), SAME);
    await forget(c, "flip", SAME);
    assert.equal(await recall(c, "flip"), null, "the forget (later op) wins deterministically despite the identical wall-clock time");
    // and the inverse order re-remembers deterministically
    await remember(c, note("flip", "back"), SAME);
    assert.equal((await recall(c, "flip"))?.body, "back");
    // history retains all three revisions (append-only: the monotonic advance never destroys a prior row)
    assert.deepEqual((await memoryHistory(c, "flip")).map((r) => r.content?.body ?? "∅"), ["content", "∅", "back"]);
  });

  test("shared memory is attributed: two agents on one slug -> both retained, current shows the latest author", async () => {
    const c = await conn();
    await remember(c, note("risk", "A's view"), T1, "agent:A");
    await remember(c, note("risk", "B's view"), T2, "agent:B");
    const now = await recall(c, "risk");
    assert.equal(now?.body, "B's view");
    assert.equal(now?.author, "agent:B"); // latest revision's author
    assert.equal((await recall(c, "risk", T1))?.author, "agent:A"); // as-of earlier -> the other author
    const hist = await memoryHistory(c, "risk");
    assert.deepEqual(hist.map((h) => h.author), ["agent:A", "agent:B"]); // both attributions retained
  });

  test("a [[link]] becomes a walkable memory-graph edge (as-of), via the SAME projection as facts", async () => {
    const c = await conn();
    await remember(c, note("a", "see [[b]] for more"), T1);
    await materializeBioEdgesAsOf(c, MEMORY_NOW);
    const edges = await c.all<{ from_id: string; to_id: string }>("SELECT from_id, to_id FROM bio_edges_as_of WHERE from_id = ?", [memorySubjectId("a")]);
    assert.ok(edges.some((e) => e.to_id === memorySubjectId("b")), "memory link a->b projects into bio_edges_as_of");
  });

  test("re-writing a note that DROPS a [[link]] retracts the edge (no phantom in bio_edges_as_of)", async () => {
    const c = await conn();
    await remember(c, note("a", "see [[b]] and [[cc]]"), T1, "agent:A");
    await materializeBioEdgesAsOf(c, MEMORY_NOW);
    let tos = (await c.all<{ to_id: string }>("SELECT to_id FROM bio_edges_as_of WHERE from_id = ?", [memorySubjectId("a")])).map((e) => e.to_id).sort();
    assert.deepEqual(tos, [memorySubjectId("b"), memorySubjectId("cc")]);

    await remember(c, note("a", "see [[b]] only now"), T2, "agent:A"); // dropped [[cc]]
    await materializeBioEdgesAsOf(c, MEMORY_NOW);
    tos = (await c.all<{ to_id: string }>("SELECT to_id FROM bio_edges_as_of WHERE from_id = ?", [memorySubjectId("a")])).map((e) => e.to_id);
    assert.deepEqual(tos, [memorySubjectId("b")], "the dropped link's edge is retracted, only b remains");
  });

  test("forget() retracts the note's link edges too (no phantom edges out of a forgotten node)", async () => {
    const c = await conn();
    await remember(c, note("a", "see [[b]]"), T1, "agent:A");
    await forget(c, "a", T2, "agent:A");
    await materializeBioEdgesAsOf(c, MEMORY_NOW);
    const edges = await c.all<{ to_id: string }>("SELECT to_id FROM bio_edges_as_of WHERE from_id = ?", [memorySubjectId("a")]);
    assert.deepEqual(edges, [], "forgetting the node also retracts its edges");
  });
});
