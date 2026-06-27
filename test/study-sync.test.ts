import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { makeStudyNote, writeStudyNote } from "../src/hosts/pi-project.js";
import { syncProjectStudyNotes } from "../src/hosts/study-sync.js";
import { reportStudyNoteGraph } from "../src/duckdb/kg-sync.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

describe("syncProjectStudyNotes (files -> graph -> DuckDB)", () => {
  test("creates schema, reads project notes, and syncs them end to end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-projsync-"));
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());

    await writeStudyNote(cwd, makeStudyNote({ slug: "acmg-pm2", kind: "cheatsheet", title: "ACMG PM2", hook: "Read on rare-variant calls.", body: "See [[gnomad-frequencies]] and [[ghost-note]]." }));
    await writeStudyNote(cwd, makeStudyNote({ slug: "gnomad-frequencies", kind: "cheatsheet", title: "gnomAD", hook: "Read before AF filters.", body: "x" }));

    // dry-run needs the tables to count, so opt into schema creation; it must write nothing.
    const dry = await syncProjectStudyNotes(conn, cwd, { createSchema: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.nodesToInsert, 2);
    assert.equal(dry.edgesToInsert, 2); // gnomad-frequencies + ghost-note
    assert.equal(dry.danglingEdges, 1); // ghost-note has no note
    assert.equal(Number((await conn.all<{ n: number }>("SELECT count(*) AS n FROM bio_nodes"))[0].n), 0);

    // explicit write
    const res = await syncProjectStudyNotes(conn, cwd, { dryRun: false, allowWrite: true });
    assert.equal(res.dryRun, false);

    const report = await reportStudyNoteGraph(conn);
    assert.equal(report.memoryNodes, 2);
    assert.equal(report.memoryEdges, 2);
    assert.equal(report.danglingEdgeCount, 1);
    assert.deepEqual(report.danglingEdges, [{ from: "memory:acmg-pm2", to: "memory:ghost-note", predicate: "references" }]);
    assert.equal(report.externalInboundEdgeCount, 0);
    assert.equal(report.externalInboundEdges.length, 0);
  });
});
