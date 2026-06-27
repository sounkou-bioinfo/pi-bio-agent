import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { makeStudyNote, writeStudyNote } from "../src/hosts/pi-project.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { KgSqlConn } from "../src/duckdb/kg-sync.js";
import { DEFAULT_NOTES_REPORT_LIMIT, mainNotes, parseNotesArgs } from "../src/cli/notes.js";

describe("parseNotesArgs", () => {
  test("parses sync with defaults (dry run) and flags", () => {
    assert.deepEqual(parseNotesArgs(["sync", "--db", "g.duckdb"]), { command: "sync", db: "g.duckdb", write: false, createSchema: false, json: false });
    assert.deepEqual(parseNotesArgs(["sync", "--db", "g.duckdb", "--write", "--create-schema", "--json"]), { command: "sync", db: "g.duckdb", write: true, createSchema: true, json: true });
  });

  test("parses report with limit, defaulting to a finite cap", () => {
    assert.deepEqual(parseNotesArgs(["report", "--db", "g.duckdb", "--limit", "5"]), { command: "report", db: "g.duckdb", limit: 5, json: false });
    assert.deepEqual(parseNotesArgs(["report", "--db", "g.duckdb"]), { command: "report", db: "g.duckdb", limit: DEFAULT_NOTES_REPORT_LIMIT, json: false });
  });

  test("rejects bad input and command-inapplicable flags", () => {
    assert.throws(() => parseNotesArgs([]), /unknown notes command/);
    assert.throws(() => parseNotesArgs(["nope", "--db", "x"]), /unknown notes command/);
    assert.throws(() => parseNotesArgs(["sync"]), /--db <path> is required/);
    // a negative value must use the = form (bare "-2" is an ambiguous option to parseArgs)
    assert.throws(() => parseNotesArgs(["report", "--db", "x", "--limit=-2"]), /non-negative integer/);
    assert.throws(() => parseNotesArgs(["report", "--db", "x", "--limit", "abc"]), /non-negative integer/);
    assert.throws(() => parseNotesArgs(["report", "--db", "x", "--bogus"]), /Unknown option/);
    // fail closed on flags that don't apply to the command
    assert.throws(() => parseNotesArgs(["sync", "--db", "x", "--limit", "5"]), /Unknown option/);
    assert.throws(() => parseNotesArgs(["report", "--db", "x", "--write"]), /Unknown option/);
    assert.throws(() => parseNotesArgs(["sync", "--db", "x", "--bogus"]), /Unknown option/);
  });
});

describe("mainNotes (end to end against in-memory DuckDB)", () => {
  async function harness() {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-cli-"));
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const lines: string[] = [];
    const deps = { cwd, openConn: async (_db: string): Promise<KgSqlConn> => conn, out: (l: string) => lines.push(l) };
    return { cwd, conn, lines, deps };
  }

  test("sync dry-run writes nothing, --write applies, report reads back", async () => {
    const { cwd, conn, lines, deps } = await harness();
    await writeStudyNote(cwd, makeStudyNote({ slug: "acmg-pm2", kind: "cheatsheet", title: "ACMG PM2", hook: "Read on rare-variant calls.", body: "See [[gnomad-frequencies]]." }));
    await writeStudyNote(cwd, makeStudyNote({ slug: "gnomad-frequencies", kind: "cheatsheet", title: "gnomAD", hook: "Read before AF filters.", body: "x" }));

    assert.equal(await mainNotes(["sync", "--db", "mem", "--create-schema"], deps), 0);
    assert.match(lines.at(-1)!, /DRY RUN/);
    assert.equal(Number((await conn.all<{ n: number }>("SELECT count(*) AS n FROM bio_nodes"))[0].n), 0);

    assert.equal(await mainNotes(["sync", "--db", "mem", "--write"], deps), 0);
    assert.match(lines.at(-1)!, /WROTE/);

    assert.equal(await mainNotes(["report", "--db", "mem", "--json"], deps), 0);
    const report = JSON.parse(lines.at(-1)!);
    assert.equal(report.memoryNodes, 2);
    assert.equal(report.memoryEdges, 1);
    assert.equal(report.danglingEdgeCount, 0);
  });

  test("missing --db exits 2 without opening a connection", async () => {
    const { lines } = await harness();
    let opened = false;
    const code = await mainNotes(["sync"], { cwd: ".", openConn: async () => { opened = true; throw new Error("should not open"); }, out: (l) => lines.push(l) });
    assert.equal(code, 2);
    assert.equal(opened, false);
    assert.match(lines.at(-1)!, /--db <path> is required/);
  });
});
