import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bioStorePath, openBioStore } from "../src/hosts/bio-store.js";
import { listMemory, recall, remember, MEMORY_NOW } from "../src/hosts/memory-store.js";
import { materializeBioEdgesAsOf, recordObservation } from "../src/duckdb/observations.js";

const note = (slug: string, body: string) => ({ slug, kind: "memory_note", title: slug, hook: `hook ${slug}`, body, tags: [] });
const T1 = "2026-01-01T00:00:01Z";
const tmp = () => fs.mkdtemp(join(tmpdir(), "biostore-"));

describe("bio-store: ONE store for memory + facts + graph (not a separate memory db)", () => {
  test("memory and facts coexist in one bio_observations; one graph closure crosses namespaces", async () => {
    const store = await openBioStore(await tmp());
    try {
      await remember(store.conn, note("acmg", "guidance"), T1, "agent:pi"); // memory: namespace
      await recordObservation(store.conn, { statementKey: "fact:1", subjectId: "gene:TP53", predicate: "associated_with", objectId: "disease:LFS", recordedAt: T1, source: "clinvar" }); // a FACT in the SAME store
      await materializeBioEdgesAsOf(store.conn, MEMORY_NOW);
      const edges = await store.conn.all<{ from_id: string; to_id: string }>("SELECT from_id, to_id FROM bio_edges_as_of");
      assert.ok(edges.some((e) => e.from_id === "gene:TP53" && e.to_id === "disease:LFS"), "the fact edge is in the ONE graph table");
      assert.equal((await recall(store.conn, "acmg"))?.author, "agent:pi"); // memory readable from the same store
      assert.equal((await listMemory(store.conn)).length, 1);
    } finally {
      store.close();
    }
  });

  test("shared across runs: a later run (fresh connection to the same store) reads the earlier run's memory", async () => {
    const cwd = await tmp();
    const run1 = await openBioStore(cwd);
    await remember(run1.conn, note("shared", "v1"), T1, "agent:A");
    run1.close(); // a run opens -> writes -> closes (DuckDB is a process-exclusive writer)
    const run2 = await openBioStore(cwd);
    try {
      const got = await recall(run2.conn, "shared");
      assert.equal(got?.body, "v1");
      assert.equal(got?.author, "agent:A"); // attribution persists across runs
    } finally {
      run2.close();
    }
  });

  test("the store is project-local under .pi/bio-agent by default", async () => {
    assert.ok(bioStorePath(await tmp()).endsWith(join(".pi", "bio-agent", "store.duckdb")));
  });
});

import { isBioStoreLocked, tryOpenBioStore } from "../src/hosts/bio-store.js";

describe("non-throwing store open (concurrency degradation)", () => {
  test("isBioStoreLocked recognizes DuckDB lock-conflict messages, not unrelated errors", () => {
    assert.equal(isBioStoreLocked(new Error("IO Error: Could not set lock on file X: Conflicting lock")), true);
    assert.equal(isBioStoreLocked(new Error("some other failure")), false);
  });
  test("tryOpenBioStore opens normally when free (returns a store, not null)", async () => {
    const store = await tryOpenBioStore(await fs.mkdtemp(join(tmpdir(), "trystore-")));
    assert.ok(store);
    store.close();
  });
});
