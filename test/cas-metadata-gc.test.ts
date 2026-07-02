import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import {
  acquireCasLease, addCasRef, dropCasRefs, gcMark, gcMarkSweep, gcSweep,
  initCasMetadata, recordCasObject, withCasObject,
} from "../src/hosts/cas-metadata.js";
import type { ContentAddress } from "../src/core/resources.js";

// The DISTRIBUTED-correct CAS GC, proven over a single in-memory DuckDB. The authority is just a DuckDB holding
// cas_object/cas_ref/cas_lease; whether it is local or ducknng-served is a transport choice — the SAME SQL runs.
// A single serialized conn here deterministically stands in for the shared authority, so these tests exercise the
// exact mark/sweep/lease logic a ducknng-RPC-shared db would run. No timing, no flakiness: clocks are injected.

async function setup() {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await initCasMetadata(conn);
  const casRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-casmeta-"));
  const cas = fsCasStore(casRoot);
  return { conn, cas };
}
const addr = (s: string): ContentAddress => ({ algorithm: "sha256", digest: createHash("sha256").update(s).digest("hex") });
async function store(cas: ReturnType<typeof fsCasStore>, conn: Awaited<ReturnType<typeof setup>>["conn"], s: string, committedAt: number): Promise<ContentAddress> {
  const a = addr(s);
  await cas.put(a, s);
  await recordCasObject(conn, a, s.length, committedAt);
  return a;
}

describe("CAS metadata GC: ref/lease anti-join (the distributed-safe sweep)", () => {
  test("a live ref protects its bytes; an unreferenced object past cutoff is tombstoned then swept", async () => {
    const { conn, cas } = await setup();
    const rooted = await store(cas, conn, "rooted bytes", 1000);
    const garbage = await store(cas, conn, "garbage bytes", 1000);
    await addCasRef(conn, { refId: "run-A", refType: "run", address: rooted }, 1000);

    const marked = await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 });
    assert.deepEqual(marked.map((m) => m.digest), [garbage.digest], "only the unreferenced object is tombstoned");

    const swept = await gcSweep(conn, cas, { graceMs: 0, nowMs: 2000 });
    assert.deepEqual(swept.map((s) => s.digest), [garbage.digest]);
    assert.equal(await cas.has(garbage), false, "garbage bytes are gone");
    assert.equal(await cas.has(rooted), true, "rooted bytes survive");
  });

  test("an active LEASE protects bytes even with NO ref (the reuse race); an expired lease does not", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "being reused by a remote writer", 1000);
    await acquireCasLease(conn, "worker-7", a, 5000, 1000); // lease valid until t=6000

    // a mark at t=2000 must NOT tombstone a leased object, even though nothing references it
    assert.deepEqual(await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 }), [], "leased object is retained");
    assert.equal(await cas.has(a), true);

    // once the lease has expired (t=7000), the same object IS collectable
    const marked = await gcMark(conn, { cutoffMs: 7000, nowMs: 7000 });
    assert.deepEqual(marked.map((m) => m.digest), [a.digest], "after lease expiry the object is tombstoned");
  });

  test("a TTL'd ref stops protecting after it expires", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "cached-with-a-ttl", 1000);
    await addCasRef(conn, { refId: "remote:url-hash", refType: "remote_index", address: a, expiresAt: 5000 }, 1000);
    assert.deepEqual(await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 }), [], "within TTL: protected");
    const marked = await gcMark(conn, { cutoffMs: 6000, nowMs: 6000 });
    assert.deepEqual(marked.map((m) => m.digest), [a.digest], "past TTL: collectable");
  });

  test("dropCasRefs releases a referrer's roots, making its bytes GC-eligible if nothing else holds them", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "held by run-old only", 1000);
    await addCasRef(conn, { refId: "run-old", refType: "run", address: a }, 1000);
    assert.deepEqual(await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 }), [], "still referenced");
    const { dropped } = await dropCasRefs(conn, "run-old");
    assert.equal(dropped, 1);
    const marked = await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 });
    assert.deepEqual(marked.map((m) => m.digest), [a.digest], "after the ref is dropped, collectable");
  });

  test("withCasObject: committed -> hit; tombstoned-but-unswept -> RESURRECTED hit; deleted -> miss", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "reuse me", 1000);

    // committed -> hit, onHit runs
    let ran = 0;
    const r1 = await withCasObject(conn, a, "reader", 1000, async () => { ran++; return "materialized"; }, 2000);
    assert.deepEqual(r1, { hit: true, result: "materialized" });
    assert.equal(ran, 1);

    // mark it (no ref, no lease now) -> tombstoned, but bytes NOT yet swept
    await gcMark(conn, { cutoffMs: 3000, nowMs: 3000 });
    assert.equal(await cas.has(a), true, "tombstoned bytes are still present during grace");
    // a reuse during the grace window RESURRECTS it under the held lease -> hit
    const r2 = await withCasObject(conn, a, "reader", 1000, async () => "materialized-again", 3500);
    assert.equal(r2.hit, true, "tombstoned-but-unswept object is revived, not a miss");
    // and a subsequent mark sees it committed again (revived) -> not immediately tombstoned at the same instant
    const reState = await conn.all<{ state: string }>(`SELECT state FROM cas_object WHERE digest = ?`, [a.digest]);
    assert.equal(reState[0].state, "committed", "revived to committed");

    // now fully sweep it (tombstone + delete) and confirm a reuse is a clean MISS
    await gcMark(conn, { cutoffMs: 4000, nowMs: 4000 });
    await gcSweep(conn, cas, { graceMs: 0, nowMs: 4000 });
    assert.equal(await cas.has(a), false, "swept");
    const r3 = await withCasObject(conn, a, "reader", 1000, async () => "should not run", 5000);
    assert.deepEqual(r3, { hit: false }, "deleted object -> miss (caller re-fetches)");
  });

  test("sweep RE-CHECKS refs/leases at claim time — a ref or lease added AFTER mark protects bytes from the sweep", async () => {
    // the race the atomic claim closes: the old SELECT-then-loop sweep would delete an object that got re-rooted or
    // leased between the mark and the delete. The claim's NOT EXISTS must re-check, so such an object is skipped.
    const { conn, cas } = await setup();

    // a NEW REF lands after the tombstone but before the sweep
    const a = await store(cas, conn, "re-rooted between mark and sweep", 1000);
    await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 });
    await addCasRef(conn, { refId: "late-run", refType: "run", address: a }, 2500);
    assert.deepEqual(await gcSweep(conn, cas, { graceMs: 0, nowMs: 3000 }), [], "a freshly-rooted tombstoned object is NOT swept");
    assert.equal(await cas.has(a), true, "its bytes survive");

    // a LEASE lands after the tombstone but before the sweep
    const b = await store(cas, conn, "leased between mark and sweep", 1000);
    await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 });
    await acquireCasLease(conn, "late-reader", b, 5000, 2500);
    assert.deepEqual(await gcSweep(conn, cas, { graceMs: 0, nowMs: 3000 }), [], "a freshly-leased tombstoned object is NOT swept");
    assert.equal(await cas.has(b), true, "its bytes survive");
  });

  test("sweep respects the grace window (a freshly-tombstoned object is not deleted until grace elapses)", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "just-tombstoned", 1000);
    await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 }); // tombstoned_at = 2000
    const early = await gcSweep(conn, cas, { graceMs: 1000, nowMs: 2500 }); // only 500ms elapsed < 1000ms grace
    assert.deepEqual(early, [], "within grace: not swept");
    assert.equal(await cas.has(a), true);
    const late = await gcSweep(conn, cas, { graceMs: 1000, nowMs: 3500 }); // 1500ms elapsed >= grace
    assert.deepEqual(late.map((s) => s.digest), [a.digest], "past grace: swept");
    assert.equal(await cas.has(a), false);
  });

  test("a failed physical remove reverts the row to tombstoned (never stuck in `deleting`) and rethrows", async () => {
    const { conn, cas } = await setup();
    const a = await store(cas, conn, "remove will fail for this one", 1000);
    await gcMark(conn, { cutoffMs: 2000, nowMs: 2000 });
    // a store whose remove throws (permissions / transient mount / object-store outage)
    const flaky = { ...cas, remove: async () => { throw new Error("EACCES: simulated remove failure"); } };
    await assert.rejects(gcSweep(conn, flaky, { graceMs: 0, nowMs: 3000 }), /simulated remove failure/);
    const st = await conn.all<{ state: string }>(`SELECT state FROM cas_object WHERE digest = ?`, [a.digest]);
    assert.equal(st[0].state, "tombstoned", "reverted to tombstoned, NOT orphaned in `deleting`");
    // a later sweep with the real store now succeeds (the row is reclaimable, not stuck)
    const swept = await gcSweep(conn, cas, { graceMs: 0, nowMs: 3500 });
    assert.deepEqual(swept.map((s) => s.digest), [a.digest], "the retry sweeps it");
    assert.equal(await cas.has(a), false);
  });

  test("cas-metadata rejects non-sha256 addresses (aligned with the sha256-only store)", async () => {
    const { conn } = await setup();
    const bad = { algorithm: "blake3", digest: "deadbeef" } as unknown as ContentAddress; // non-sha256: type-narrowed away, still refused at runtime
    await assert.rejects(recordCasObject(conn, bad, 4, 1000), /only sha256/);
    await assert.rejects(addCasRef(conn, { refId: "r", refType: "run", address: bad }, 1000), /only sha256/);
    await assert.rejects(acquireCasLease(conn, "h", bad, 1000, 1000), /only sha256/);
    // a sha256 address with a MALFORMED digest is also refused (fail closed at the entry, not later during sweep)
    const badHex = { algorithm: "sha256", digest: "deadbeef" } as ContentAddress; // too short / not 64 hex
    await assert.rejects(recordCasObject(conn, badHex, 4, 1000), /invalid sha256 digest/);
    await assert.rejects(acquireCasLease(conn, "h", badHex, 1000, 1000), /invalid sha256 digest/);
  });

  test("gcMarkSweep end-to-end with one minAgeMs knob", async () => {
    const { conn, cas } = await setup();
    const keep = await store(cas, conn, "keep", 1000);
    const drop = await store(cas, conn, "drop", 1000);
    await addCasRef(conn, { refId: "run-1", refType: "run", address: keep }, 1000);
    // nowMs=5000, minAgeMs=1000 -> cutoff 4000 (drop is older), grace 1000 (tombstoned_at would be 5000, so this
    // pass tombstones but does not yet sweep — sweep needs a later pass). Verify the two-phase behaviour.
    const first = await gcMarkSweep(conn, cas, { minAgeMs: 1000, nowMs: 5000 });
    assert.deepEqual(first.marked.map((m) => m.digest), [drop.digest]);
    assert.deepEqual(first.swept, [], "not swept in the same pass (grace not elapsed)");
    const second = await gcMarkSweep(conn, cas, { minAgeMs: 1000, nowMs: 7000 });
    assert.deepEqual(second.swept.map((s) => s.digest), [drop.digest], "swept on a later pass past grace");
    assert.equal(await cas.has(keep), true);
    assert.equal(await cas.has(drop), false);
  });
});
