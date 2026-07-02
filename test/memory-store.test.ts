import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { forget, listMemory, memoryHistory, memorySubjectId, normalizeAsOf, recall, remember, MEMORY_NOW } from "../src/hosts/memory-store.js";
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

  test("the NOTE is the atomic linearization point: a derived-edge write failure keeps the committed note, edge reconciled next", async () => {
    const c = await conn();
    await remember(c, note("base", "seed"), T1, "agent:A"); // an existing revision
    // Fail the first edge INSERT (recordObservation, via `run`). The note is written via the compare-and-set
    // primitive (INSERT ... RETURNING, via `all`) BEFORE the edges, so it has already committed when the edge fails.
    let edgeInserts = 0;
    const faulty: SqlConn = {
      all: (sql, params) => c.all(sql, params),
      run: (sql, params) => {
        if (/INSERT INTO bio_observations/i.test(sql) && ++edgeInserts === 1) throw new Error("injected edge-write failure");
        return c.run(sql, params);
      },
    };
    // Full-revision rollback is impossible while keeping the note linearizable over a shared server (a wrapping
    // transaction's snapshot would defeat the CAS). So the contract is: the note (the user's content) commits
    // atomically and is NEVER lost to a derived-edge error; the failed edge is simply absent, reconciled by the
    // next remember. This is strictly safer for the primary content than the old all-or-nothing rollback.
    await assert.rejects(() => remember(faulty, { ...note("base", "NEW body [[other]]"), slug: "base" }, T2, "agent:B"), /injected edge-write failure/);
    const still = await recall(c, "base");
    assert.equal(still?.body, "NEW body [[other]]", "the note content committed atomically; a derived-edge error did not lose it");
    const edges = await liveOutEdgesAsOf(c, memorySubjectId("base"), MEMORY_NOW);
    assert.deepEqual(edges, [], "the failed edge is absent (append-only, not half-written)");
    // a subsequent successful remember reconciles the [[other]] edge
    await remember(c, { ...note("base", "again [[other]]"), slug: "base" }, "2026-01-03T00:00:00.000Z", "agent:A");
    assert.equal((await liveOutEdgesAsOf(c, memorySubjectId("base"), MEMORY_NOW)).length, 1, "the next remember reconciles the edge");
  });

  test("concurrent same-slug remembers get distinct, strictly-ordered revisions — no tie (residue #2)", async () => {
    const c = await conn();
    const N = 20;
    // SAME wall clock for all: without the monotonic advance + compare-and-set they would collide on recorded_at
    // and 'current' would be a hash-arbitrary tiebreak. The CAS makes each revision take a strictly-later instant.
    const wall = "2026-01-01T00:00:00.000Z";
    await Promise.all(Array.from({ length: N }, (_, i) => remember(c, note("hot", `body ${i}`), wall, `agent:${i}`)));
    const hist = await memoryHistory(c, "hot"); // oldest-first
    assert.equal(hist.length, N, "all N concurrent remembers landed as distinct revisions (none lost, none tied)");
    const times = hist.map((h) => h.recordedAt);
    assert.equal(new Set(times).size, N, "every revision got a DISTINCT recorded_at — the CAS prevented same-timestamp ties");
    for (let i = 1; i < times.length; i++) assert.ok(Date.parse(times[i]!) > Date.parse(times[i - 1]!), "recorded_at is strictly increasing");
    assert.equal((await listMemory(c)).filter((m) => m.slug === "hot").length, 1, "exactly one current revision — deterministic latest, no ambiguous tie");
  });

  test("reads on a FRESH store (no schema) return empty/null, not a missing-table throw", async () => {
    const c = await conn(); // NO createBioObservationSchema — a bare connection
    assert.equal(await recall(c, "nope"), null, "recall of an unprovisioned store is null");
    assert.deepEqual(await listMemory(c), [], "listMemory of an unprovisioned store is empty");
    assert.deepEqual(await memoryHistory(c, "nope"), [], "memoryHistory of an unprovisioned store is empty");
  });

  test("normalizeAsOf canonicalizes to UTC and rejects tz-less/lenient forms — shared by the CLI AND the Pi tools", () => {
    assert.equal(normalizeAsOf(undefined), MEMORY_NOW, "undefined -> now/latest");
    assert.equal(normalizeAsOf("2026-01-01"), "2026-01-01T00:00:00.000Z", "date-only -> UTC midnight");
    assert.equal(normalizeAsOf("2026-01-01T12:00:00Z"), "2026-01-01T12:00:00.000Z");
    assert.equal(normalizeAsOf("2026-01-01T12:00:00+02:00"), "2026-01-01T10:00:00.000Z", "offset normalized to UTC");
    assert.throws(() => normalizeAsOf("2026-01-01T12:00:00"), /timezone/, "a tz-less time is rejected (host-dependent otherwise)");
    assert.throws(() => normalizeAsOf("March 1 2026"), /ISO-8601/);
    assert.throws(() => normalizeAsOf("2026/01/01"), /ISO-8601/);
    // CALENDAR validation: a well-FORMED but invalid date must be rejected, not silently rolled over by Date.parse
    assert.throws(() => normalizeAsOf("2026-02-31"), /ISO-8601/, "Feb 31 rejected (would roll to Mar 3)");
    assert.throws(() => normalizeAsOf("2026-13-01"), /ISO-8601/, "month 13 rejected");
    assert.throws(() => normalizeAsOf("2026-01-01T25:00:00Z"), /ISO-8601/, "hour 25 rejected");
    assert.equal(normalizeAsOf("2024-02-29"), "2024-02-29T00:00:00.000Z", "leap day accepted");
    assert.throws(() => normalizeAsOf("2026-02-29"), /ISO-8601/, "Feb 29 in a non-leap year rejected");
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
