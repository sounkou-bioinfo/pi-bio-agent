import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { forget, listMemory, memoryHistory, memorySubjectId, recall, remember, MEMORY_NOW } from "../src/hosts/memory-store.js";
import { materializeBioEdgesAsOf, liveOutEdgesAsOf, recordObservation } from "../src/duckdb/observations.js";

const conn = async (): Promise<SqlConn> => duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
const note = (slug: string, body: string) => ({ slug, kind: "memory_note", title: slug, hook: `hook ${slug}`, body, tags: [] });

const T0 = "2026-01-01T00:00:00Z";
const T1 = "2026-01-01T00:00:01Z";
const T2 = "2026-01-01T00:00:02Z";

// Memory unified into the temporal store: history + as-of + retraction, the same store as facts.
describe("temporal memory over bio_observations", () => {
  test("a write AT/AFTER the MEMORY_NOW sentinel is rejected — a real timestamp must be < 9999 (else invisible to default recall)", async () => {
    const c = await conn();
    await assert.rejects(() => remember(c, note("s", "x"), MEMORY_NOW), /strictly before the reserved sentinel/);
    await assert.rejects(() => remember(c, note("s", "x"), "9999-12-31T23:59:59.999Z"), /strictly before the reserved sentinel/);
    await assert.rejects(() => forget(c, "s", MEMORY_NOW), /strictly before the reserved sentinel/);
    // a normal (real) timestamp still works and is recallable as of now
    await remember(c, note("s", "ok"), T1);
    assert.equal((await recall(c, "s"))?.body, "ok");
  });

  test("concurrent same-slug remember() are SERIALIZED — distinct monotonic timestamps, N distinct revisions (no collision)", async () => {
    const c = await conn();
    const N = 12;
    // fire N concurrent remembers of ONE slug at the SAME wall clock — withSlotLock(subject) must serialize them so
    // each gets a strictly-later recorded_at (no two collide on the hash-arbitrary observation_id tiebreak).
    await Promise.all(Array.from({ length: N }, (_, i) => remember(c, note("race", `body ${i}`), "2026-01-01T00:00:00.000Z", `agent:${i}`)));
    const hist = await memoryHistory(c, "race");
    assert.equal(hist.length, N, "all N concurrent revisions landed distinctly");
    assert.equal(new Set(hist.map((r) => r.recordedAt)).size, N, "every revision got a DISTINCT recorded_at (serialized monotonic advance)");
    const latest = await recall(c, "race");
    assert.ok(latest, "a deterministic latest exists");
  });

  test("ATOMIC revision: a mid-write insert failure ROLLS BACK the whole remember — no partial content/edges", async () => {
    const c = await conn();
    await remember(c, note("base", "seed"), T1, "agent:A"); // an existing revision to prove it survives the failed write
    // wrap the conn so the 2nd INSERT (the link edge, after the content insert) throws — simulating a mid-txn failure
    let inserts = 0;
    const faulty: SqlConn = {
      all: (sql, params) => c.all(sql, params),
      run: (sql, params) => {
        if (/INSERT INTO bio_observations/i.test(sql) && ++inserts === 2) throw new Error("injected mid-write failure");
        return c.run(sql, params);
      },
    };
    await assert.rejects(() => remember(faulty, { ...note("base", "NEW body [[other]]"), slug: "base" }, T2, "agent:B"), /injected mid-write failure/);
    // the transaction rolled back: the base note still reads its ORIGINAL content, and the failed revision's edge is absent
    const still = await recall(c, "base");
    assert.equal(still?.body, "seed", "the failed remember rolled back — original content intact, no partial revision");
    const edges = await liveOutEdgesAsOf(c, memorySubjectId("base"), MEMORY_NOW);
    assert.deepEqual(edges, [], "no partial link edge from the rolled-back revision");
  });

  test("reads on a FRESH store (no schema) return empty/null, not a missing-table throw", async () => {
    const c = await conn(); // NO createBioObservationSchema — a bare connection
    assert.equal(await recall(c, "nope"), null, "recall of an unprovisioned store is null");
    assert.deepEqual(await listMemory(c), [], "listMemory of an unprovisioned store is empty");
    assert.deepEqual(await memoryHistory(c, "nope"), [], "memoryHistory of an unprovisioned store is empty");
  });

  test("citations (sources) are persisted INTO the ledger, so recall/shared memory keep provenance (not just the file view)", async () => {
    const c = await conn();
    const sources = [{ url: "https://www.ebi.ac.uk/ols4", locator: "MONDO:0004979", quote: "asthma" }];
    await remember(c, { ...note("cited", "asthma is MONDO:0004979"), sources }, T1, "agent:A");
    const r = await recall(c, "cited");
    assert.deepEqual(r?.sources, sources, "the citation survived the round-trip through the temporal store");
    // a re-write WITHOUT sources supersedes and drops them (latest-wins), so they aren't silently sticky
    await remember(c, note("cited", "asthma is MONDO:0004979"), T2, "agent:A");
    assert.equal((await recall(c, "cited"))?.sources, undefined, "a later revision with no sources supersedes — sources are per-revision, not sticky");
  });

  test("reconciliation only touches MEMORY's own wikilink edges — a foreign edge fact from the same subject survives", async () => {
    const c = await conn();
    await remember(c, note("foo", "hi [[bar]]"), T1); // a memory wikilink edge foo|<pred>|bar
    const subject = memorySubjectId("foo");
    // another subsystem records an UNRELATED edge fact out of the same agent:memory:foo subject (its OWN statement_key)
    await recordObservation(c, { statementKey: `fact:supports:foo:disease:X`, subjectId: subject, predicate: "supports", objectId: "disease:X", recordedAt: T1 });
    // rewrite the note dropping [[bar]] — the memory edge is retracted, but the foreign 'supports' fact must NOT be
    await remember(c, note("foo", "no links now"), T2);
    const edges = await liveOutEdgesAsOf(c, subject, MEMORY_NOW);
    assert.ok(edges.some((e) => e.statement_key === "fact:supports:foo:disease:X"), "the foreign edge fact survives reconciliation");
    assert.ok(!edges.some((e) => e.statement_key.startsWith(subject + "|")), "the dropped memory wikilink IS retracted");
    // forget() likewise must not clobber the foreign fact
    await forget(c, "foo", "2026-01-01T00:00:03Z");
    const after = await liveOutEdgesAsOf(c, subject, MEMORY_NOW);
    assert.ok(after.some((e) => e.statement_key === "fact:supports:foo:disease:X"), "forget() leaves the foreign edge fact alone");
  });

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
