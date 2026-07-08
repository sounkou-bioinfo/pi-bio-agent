import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import { mainGraphWindow } from "../src/cli/graph-window.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { cwd: process.cwd(), out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

async function tempDb(): Promise<string> {
  return join(await fsp.mkdtemp(join(tmpdir(), "graph-window-cli-")), "store.duckdb");
}

async function writeDb(path: string, fn: (conn: SqlConn) => Promise<void>): Promise<void> {
  const inst = await DuckDBInstance.create(path);
  const raw = await inst.connect();
  try {
    await fn(duckdbNodeConn(raw));
  } finally {
    raw.closeSync();
    inst.closeSync();
  }
}

describe("cli: graph-window over existing DuckDB graph tables", () => {
  test("pages a ledger-style bio_edges table without a manifest", async () => {
    const dbPath = await tempDb();
    await writeDb(dbPath, async (conn) => {
      await conn.run("CREATE TABLE bio_edges (from_id TEXT, predicate TEXT, to_id TEXT)");
      await conn.run("INSERT INTO bio_edges VALUES ('run:r1','uses','artifact:a')");
      await conn.run("INSERT INTO bio_edges VALUES ('run:r1','uses','artifact:b')");
    });

    const s = sink();
    const code = await mainGraphWindow(["--db", dbPath, "--start", "run:r1", "--limit", "1"], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as { schema: string; totalCount: number; omittedCount: number; rows: Array<{ from_id: string; predicate: string; to_id: string }> };
    assert.equal(printed.schema, "pi-bio.graph_query_window.v1");
    assert.equal(printed.totalCount, 2);
    assert.equal(printed.omittedCount, 1);
    assert.deepEqual(printed.rows, [{ from_id: "run:r1", predicate: "uses", to_id: "artifact:a" }]);
  });

  test("walks a schema-qualified external KG table with predicate filtering", async () => {
    const dbPath = await tempDb();
    await writeDb(dbPath, async (conn) => {
      await conn.run("CREATE SCHEMA kg");
      await conn.run("CREATE TABLE kg.bio_edges (from_id TEXT, predicate TEXT, to_id TEXT)");
      await conn.run("INSERT INTO kg.bio_edges VALUES ('MONDO:child','biolink:subclass_of','MONDO:root')");
      await conn.run("INSERT INTO kg.bio_edges VALUES ('MONDO:sibling','biolink:related_to','MONDO:root')");
      await conn.run("INSERT INTO kg.bio_edges VALUES ('MONDO:root','biolink:has_part','MONDO:leaf')");
    });

    const s = sink();
    const code = await mainGraphWindow([
      "--db", dbPath,
      "--table", "kg.bio_edges",
      "--start-id", "MONDO:root",
      "--direction", "both",
      "--predicates", "biolink:subclass_of",
    ], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as { totalCount: number; rows: Array<{ from_id: string; predicate: string; to_id: string }> };
    assert.equal(printed.totalCount, 1);
    assert.deepEqual(printed.rows, [{ from_id: "MONDO:child", predicate: "biolink:subclass_of", to_id: "MONDO:root" }]);
  });

  test("usage and unsafe table failures are explicit", async () => {
    const s = sink();
    assert.equal(await mainGraphWindow(["--start", "x"], s.deps), 2);
    assert.match(s.err.join("\n"), /requires --db/);

    const s1b = sink();
    assert.equal(await mainGraphWindow(["--db", ":memory:", "--start", "x", "--direction", "sideways"], s1b.deps), 2);
    assert.match(s1b.err.join("\n"), /direction must be/);

    const dbPath = await tempDb();
    await writeDb(dbPath, async (conn) => {
      await conn.run("CREATE TABLE bio_edges (from_id TEXT, predicate TEXT, to_id TEXT)");
    });
    const s2 = sink();
    assert.equal(await mainGraphWindow(["--db", dbPath, "--start", "x", "--table", "bio_edges;DROP"], s2.deps), 1);
    assert.match(s2.err.join("\n"), /SQL identifier/);
  });
});
