import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { studyNoteGraph, type StudyNote } from "../src/core/study.js";
import { createBioGraphSchema, syncStudyNoteGraph, type KgSqlConn } from "../src/duckdb/kg-sync.js";

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
    const firstCount = idx((s) => s.startsWith("SELECT count("));
    // ownership-scoped deletes, bracketed by a single transaction
    assert.ok(begin >= 0 && commit > begin, "writes are wrapped in BEGIN/COMMIT");
    // TOCTOU: the count/external-inbound check runs INSIDE the transaction, before the deletes.
    assert.ok(begin < firstCount && firstCount < delEdges, "counts/check run after BEGIN, before delete");
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

  test("fails closed on duplicate node ids or duplicate edges", async () => {
    const { conn } = fakeConn({ nodes: 0, edges: 0 });
    const dupNodes = {
      schema: "pi-bio.graph_snapshot.v1" as const,
      nodes: [
        { id: "memory:a", family: "memory" as const, type: "cheatsheet", label: "a" },
        { id: "memory:a", family: "memory" as const, type: "cheatsheet", label: "a again" },
      ],
      edges: [],
    };
    await assert.rejects(() => syncStudyNoteGraph(conn, dupNodes), /duplicate node id memory:a/);

    const dupEdges = {
      schema: "pi-bio.graph_snapshot.v1" as const,
      nodes: [{ id: "memory:a", family: "memory" as const, type: "cheatsheet", label: "a" }],
      edges: [
        { from: "memory:a", to: "memory:b", predicate: "references" },
        { from: "memory:a", to: "memory:b", predicate: "references" },
      ],
    };
    await assert.rejects(() => syncStudyNoteGraph(conn, dupEdges), /duplicate edge memory:a -> memory:b/);

    // Same endpoints but a different predicate is NOT a duplicate.
    const distinct = {
      schema: "pi-bio.graph_snapshot.v1" as const,
      nodes: [{ id: "memory:a", family: "memory" as const, type: "cheatsheet", label: "a" }],
      edges: [
        { from: "memory:a", to: "memory:b", predicate: "references" },
        { from: "memory:a", to: "memory:b", predicate: "depends_on" },
      ],
    };
    const res = await syncStudyNoteGraph(conn, distinct);
    assert.equal(res.edgesToInsert, 2);
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
    // The guard must protect the actual delete set: join family='memory' nodes, not match a to_id prefix.
    const extSql = dry.statements.map((s) => s.sql).find((s) => s.includes("from_id NOT LIKE"));
    assert.ok(extSql?.includes("JOIN bio_nodes") && extSql.includes("n.family = 'memory'"), "external-inbound guard joins the delete set");
    assert.ok(!extSql?.includes("to_id LIKE 'memory:%'"), "guard does not scope inbound edges by to_id prefix");

    const write = fakeConn({ nodes: 1, edges: 1, externalInbound: 1 });
    await assert.rejects(() => syncStudyNoteGraph(write.conn, snapshot, { dryRun: false, allowWrite: true }), /non-owned edges point into them/);
    const wsqls = write.statements.map((s) => s.sql);
    const wbegin = wsqls.findIndex((s) => s === "BEGIN");
    const wcount = wsqls.findIndex((s) => s.startsWith("SELECT count("));
    // The check is inside the transaction (count after BEGIN), and it rolls back without touching owned rows.
    assert.ok(wbegin >= 0 && wcount > wbegin, "external-inbound check runs after BEGIN");
    assert.ok(!wsqls.some((s) => /^(DELETE|INSERT)/.test(s)), "no delete/insert when external inbound edges exist");
    assert.ok(wsqls.includes("ROLLBACK"), "rolls back after refusing");
  });
});

describe("createBioGraphSchema", () => {
  test("emits bio_nodes/bio_edges DDL encoding the duplicate policy, no FKs", async () => {
    const { conn, statements } = fakeConn({ nodes: 0, edges: 0 });
    await createBioGraphSchema(conn);
    const ddl = statements.map((s) => s.sql);
    assert.equal(ddl.length, 2);
    assert.ok(ddl[0].startsWith("CREATE TABLE bio_nodes") && ddl[0].includes("node_id TEXT PRIMARY KEY"), "node_id is the primary key");
    assert.ok(ddl[1].startsWith("CREATE TABLE bio_edges") && ddl[1].includes("UNIQUE (from_id, to_id, predicate)"), "edges unique by triple");
    // dangling targets are allowed by design, so no foreign keys
    assert.ok(!ddl.some((s) => /FOREIGN KEY|REFERENCES/.test(s)), "no foreign-key constraints");
    assert.ok(!ddl.some((s) => s.includes("IF NOT EXISTS")), "plain CREATE by default");
  });

  test("ifNotExists makes it idempotent", async () => {
    const { conn, statements } = fakeConn({ nodes: 0, edges: 0 });
    await createBioGraphSchema(conn, { ifNotExists: true });
    assert.ok(statements.every((s) => s.sql.includes("CREATE TABLE IF NOT EXISTS")), "all tables use IF NOT EXISTS");
  });
});
