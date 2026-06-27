import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { studyNoteGraph, type StudyNote } from "../src/core/study.js";
import { syncStudyNoteGraph, type KgSqlConn } from "../src/duckdb/kg-sync.js";

function note(slug: string, body: string, links?: StudyNote["links"]): StudyNote {
  return {
    schema: "pi-bio.study_note.v1",
    slug,
    id: slug,
    kind: "cheatsheet",
    title: slug,
    hook: `Read about ${slug}.`,
    body,
    tags: [],
    ...(links ? { links } : {}),
    sources: [],
    createdAt: "t",
    updatedAt: "t",
  };
}

function fakeConn(counts: { nodes: number; edges: number; externalInbound?: number }) {
  const statements: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const conn: KgSqlConn = {
    async all(sql: string) {
      statements.push({ sql });
      // The external-inbound query also reads bio_edges, so match it first by its distinguishing clause.
      if (sql.includes("from_id NOT LIKE")) return [{ n: counts.externalInbound ?? 0 }] as never;
      if (sql.includes("FROM bio_nodes")) return [{ n: counts.nodes }] as never;
      if (sql.includes("FROM bio_edges")) return [{ n: counts.edges }] as never;
      return [] as never;
    },
    async run(sql: string, params?: readonly unknown[]) {
      statements.push({ sql, params });
    },
  };
  return { conn, statements };
}

describe("syncStudyNoteGraph", () => {
  const snapshot = studyNoteGraph([note("acmg-pm2", "See [[gnomad-frequencies]]."), note("gnomad-frequencies", "x")]);

  test("dry-runs by default: returns counts, writes nothing", async () => {
    const { conn, statements } = fakeConn({ nodes: 3, edges: 5 });
    const res = await syncStudyNoteGraph(conn, snapshot);
    assert.deepEqual(res, {
      dryRun: true,
      nodesToDelete: 3,
      edgesToDelete: 5,
      nodesToInsert: 2,
      edgesToInsert: 1,
      danglingEdges: 0,
      externalInboundEdges: 0,
    });
    assert.ok(!statements.some((s) => /^(BEGIN|DELETE|INSERT|COMMIT)/.test(s.sql)), "dry run must not write");
  });

  test("reports dangling edges without materializing stub nodes", async () => {
    const { conn } = fakeConn({ nodes: 0, edges: 0 });
    const res = await syncStudyNoteGraph(conn, studyNoteGraph([note("acmg-pm2", "See [[ghost-note]].")]));
    assert.equal(res.edgesToInsert, 1);
    assert.equal(res.nodesToInsert, 1); // only the source note, no stub for ghost-note
    assert.equal(res.danglingEdges, 1);
  });

  test("writes only with explicit opt-in, scoped, in one transaction", async () => {
    const { conn, statements } = fakeConn({ nodes: 1, edges: 1 });
    await syncStudyNoteGraph(conn, snapshot, { dryRun: false, allowWrite: true });
    const sqls = statements.map((s) => s.sql);
    const idx = (pred: (s: string) => boolean) => sqls.findIndex(pred);
    const begin = idx((s) => s === "BEGIN");
    const commit = idx((s) => s === "COMMIT");
    const delNodes = idx((s) => s.startsWith("DELETE FROM bio_nodes"));
    const delEdges = idx((s) => s.startsWith("DELETE FROM bio_edges"));
    const insNodes = idx((s) => s.startsWith("INSERT INTO bio_nodes"));
    // ownership-scoped deletes, bracketed by a single transaction
    assert.ok(begin >= 0 && commit > begin, "writes are wrapped in BEGIN/COMMIT");
    assert.ok(begin < delEdges && delNodes < commit, "deletes happen inside the transaction");
    assert.ok(sqls.some((s) => s.includes("WHERE family = 'memory'")), "only deletes memory nodes");
    assert.ok(sqls.some((s) => s.includes("WHERE from_id LIKE 'memory:%'")), "only deletes memory-origin edges");
    // edges before nodes on delete; nodes before edges on insert (FK-safe ordering)
    assert.ok(delEdges < delNodes && delNodes < insNodes, "delete edges, then nodes, then insert");
    assert.ok(insNodes < idx((s) => s.startsWith("INSERT INTO bio_edges")), "insert nodes before edges");
  });

  test("rolls back and rethrows if a write fails mid-transaction", async () => {
    const calls: string[] = [];
    const conn: KgSqlConn = {
      async all() {
        return [{ n: 0 }] as never;
      },
      async run(sql: string) {
        calls.push(sql);
        if (sql.startsWith("INSERT")) throw new Error("boom");
      },
    };
    await assert.rejects(() => syncStudyNoteGraph(conn, snapshot, { dryRun: false, allowWrite: true }), /boom/);
    assert.ok(calls.includes("ROLLBACK") && !calls.includes("COMMIT"), "failed write rolls back, never commits");
  });

  test("refuses to write without allowWrite", async () => {
    const { conn, statements } = fakeConn({ nodes: 0, edges: 0 });
    await assert.rejects(() => syncStudyNoteGraph(conn, snapshot, { dryRun: false }), /allowWrite/);
    assert.ok(!statements.some((s) => /^(BEGIN|DELETE|INSERT)/.test(s.sql)), "no writes attempted");
  });

  test("fails closed on a non-memory snapshot (even in dry run)", async () => {
    const { conn } = fakeConn({ nodes: 0, edges: 0 });
    const foreign = {
      schema: "pi-bio.graph_snapshot.v1" as const,
      nodes: [{ id: "variant:1", family: "variant" as const, type: "variant", label: "v" }],
      edges: [],
    };
    await assert.rejects(() => syncStudyNoteGraph(conn, foreign), /refusing non-memory node/);
    const foreignEdge = {
      schema: "pi-bio.graph_snapshot.v1" as const,
      nodes: [],
      edges: [{ from: "variant:1", to: "memory:x", predicate: "references" }],
    };
    await assert.rejects(() => syncStudyNoteGraph(conn, foreignEdge), /refusing edge from non-memory node/);
  });

  test("rejects malformed memory: ids (prefix is not enough)", async () => {
    const { conn } = fakeConn({ nodes: 0, edges: 0 });
    for (const id of ["memory:", "memory:Bad Slug", "memory:../x", "memory:trailing-"]) {
      const bad = {
        schema: "pi-bio.graph_snapshot.v1" as const,
        nodes: [{ id, family: "memory" as const, type: "cheatsheet", label: "x" }],
        edges: [],
      };
      await assert.rejects(() => syncStudyNoteGraph(conn, bad), /refusing non-memory node/, `should reject ${id}`);
    }
  });

  test("counts external inbound edges in dry-run and refuses to write while any exist", async () => {
    const dry = fakeConn({ nodes: 1, edges: 1, externalInbound: 2 });
    const res = await syncStudyNoteGraph(dry.conn, snapshot);
    assert.equal(res.externalInboundEdges, 2);

    const write = fakeConn({ nodes: 1, edges: 1, externalInbound: 1 });
    await assert.rejects(() => syncStudyNoteGraph(write.conn, snapshot, { dryRun: false, allowWrite: true }), /non-owned edges point into them/);
    // The check runs inside the transaction, so it may BEGIN, but it rolls back without touching owned rows.
    assert.ok(!write.statements.some((s) => /^(DELETE|INSERT)/.test(s.sql)), "no delete/insert when external inbound edges exist");
    assert.ok(write.statements.some((s) => s.sql === "ROLLBACK"), "rolls back after refusing");
  });
});
