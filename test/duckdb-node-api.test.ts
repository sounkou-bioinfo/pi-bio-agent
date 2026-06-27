import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { studyNoteGraph, type StudyNote } from "../src/core/study.js";
import { createBioGraphSchema, reportStudyNoteGraph, syncStudyNoteGraph } from "../src/duckdb/kg-sync.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

function note(slug: string, body: string): StudyNote {
  return { schema: "pi-bio.study_note.v1", slug, id: slug, kind: "cheatsheet", title: slug, hook: `Read about ${slug}.`, body, tags: [], sources: [], createdAt: "t", updatedAt: "t" };
}

async function memoryConn() {
  const instance = await DuckDBInstance.create(":memory:");
  return duckdbNodeConn(await instance.connect());
}

const count = async (conn: Awaited<ReturnType<typeof memoryConn>>, where: string) =>
  Number((await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${where}`))[0].n);

describe("duckdbNodeConn (real in-memory DuckDB)", () => {
  test("creates schema, syncs the memory subgraph, and re-syncs idempotently", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    const snapshot = studyNoteGraph([note("acmg-pm2", "See [[gnomad-frequencies]] and [[ghost-note]]."), note("gnomad-frequencies", "x")]);

    const r1 = await syncStudyNoteGraph(conn, snapshot, { dryRun: false, allowWrite: true });
    assert.equal(r1.nodesToInsert, 2);
    assert.equal(r1.edgesToInsert, 2);
    assert.equal(r1.danglingEdges, 1); // ghost-note has no node
    assert.equal(await count(conn, "bio_nodes"), 2);
    assert.equal(await count(conn, "bio_edges"), 2);
    // dangling edge is persisted: no FK constraint blocks an edge to an absent node
    assert.equal(await count(conn, "bio_edges WHERE to_id = 'memory:ghost-note'"), 1);

    // re-sync is a full replace, not an append: counts reflect delete+reinsert and rows don't double
    const r2 = await syncStudyNoteGraph(conn, snapshot, { dryRun: false, allowWrite: true });
    assert.equal(r2.nodesToDelete, 2);
    assert.equal(r2.edgesToDelete, 2);
    assert.equal(await count(conn, "bio_nodes"), 2);
    assert.equal(await count(conn, "bio_edges"), 2);
  });

  test("dry-run reports counts and writes nothing", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    const res = await syncStudyNoteGraph(conn, studyNoteGraph([note("a", "x")]));
    assert.equal(res.dryRun, true);
    assert.equal(res.nodesToInsert, 1);
    assert.equal(await count(conn, "bio_nodes"), 0); // nothing written
  });

  test("the UNIQUE(from_id,to_id,predicate) constraint matches the adapter's duplicate policy", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    const insert = "INSERT INTO bio_edges (from_id, to_id, predicate, attrs, trust) VALUES (?, ?, ?, ?::JSON, ?::JSON)";
    await conn.run(insert, ["memory:a", "memory:b", "references", null, null]);
    await assert.rejects(() => conn.run(insert, ["memory:a", "memory:b", "references", null, null]));
    // same endpoints, different predicate is allowed (distinct, not a duplicate)
    await conn.run(insert, ["memory:a", "memory:b", "depends_on", null, null]);
    assert.equal(await count(conn, "bio_edges"), 2);
  });

  test("external inbound edge blocks a write (fails closed, rolls back)", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    await syncStudyNoteGraph(conn, studyNoteGraph([note("acmg-pm2", "x")]), { dryRun: false, allowWrite: true });
    // a non-owned node with an edge pointing into the memory node we'd delete
    await conn.run("INSERT INTO bio_nodes (node_id, family, type, label) VALUES ('variant:1', 'variant', 'variant', 'v')");
    await conn.run("INSERT INTO bio_edges (from_id, to_id, predicate) VALUES ('variant:1', 'memory:acmg-pm2', 'about')");

    const dry = await syncStudyNoteGraph(conn, studyNoteGraph([note("acmg-pm2", "x")]));
    assert.equal(dry.externalInboundEdges, 1);
    await assert.rejects(
      () => syncStudyNoteGraph(conn, studyNoteGraph([note("acmg-pm2", "x")]), { dryRun: false, allowWrite: true }),
      /non-owned edges point into them/,
    );
    // the memory node survives the refused write
    assert.equal(await count(conn, "bio_nodes WHERE node_id = 'memory:acmg-pm2'"), 1);
  });

  test("reportStudyNoteGraph surfaces counts, dangling links, and external inbound edges", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    await syncStudyNoteGraph(
      conn,
      studyNoteGraph([note("acmg-pm2", "See [[gnomad-frequencies]] and [[ghost-note]]."), note("gnomad-frequencies", "x")]),
      { dryRun: false, allowWrite: true },
    );
    await conn.run("INSERT INTO bio_nodes (node_id, family, type, label) VALUES ('variant:1', 'variant', 'variant', 'v')");
    await conn.run("INSERT INTO bio_edges (from_id, to_id, predicate) VALUES ('variant:1', 'memory:acmg-pm2', 'about')");

    const report = await reportStudyNoteGraph(conn);
    assert.equal(report.memoryNodes, 2);
    assert.equal(report.memoryEdges, 2); // both edges originate at memory:acmg-pm2
    assert.equal(report.danglingEdgeCount, 1);
    assert.deepEqual(report.danglingEdges, [{ from: "memory:acmg-pm2", to: "memory:ghost-note", predicate: "references" }]);
    assert.equal(report.externalInboundEdgeCount, 1);
    assert.deepEqual(report.externalInboundEdges, [{ from: "variant:1", to: "memory:acmg-pm2", predicate: "about" }]);
  });

  test("report --limit caps rows but keeps counts exact", async () => {
    const conn = await memoryConn();
    await createBioGraphSchema(conn, { ifNotExists: true });
    // three dangling links from one note
    await syncStudyNoteGraph(conn, studyNoteGraph([note("acmg-pm2", "[[ghost-a]] [[ghost-b]] [[ghost-c]]")]), { dryRun: false, allowWrite: true });

    const full = await reportStudyNoteGraph(conn);
    assert.equal(full.danglingEdgeCount, 3);
    assert.equal(full.danglingEdges.length, 3);

    const capped = await reportStudyNoteGraph(conn, { limit: 2 });
    assert.equal(capped.danglingEdgeCount, 3); // exact total survives the cap
    assert.equal(capped.danglingEdges.length, 2); // sample is capped

    await assert.rejects(() => reportStudyNoteGraph(conn, { limit: -1 }), /non-negative integer/);
  });
});
