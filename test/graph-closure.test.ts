import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";

// SemanticSQL's shape over OUR graph: bio_edges is the statement base; entailed_edge is the transitive
// closure. Descendants / subsumption become a plain JOIN — the same SQL whether the edges came from an
// imported ontology or our own committed graph. Closure is per-predicate (is-a does not leak into part-of).

async function graphConn(edges: Array<[string, string, string]>): Promise<SqlConn> {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await conn.run("CREATE TABLE bio_edges (from_id TEXT, to_id TEXT, predicate TEXT)");
  for (const [from_id, predicate, to_id] of edges) {
    await conn.run("INSERT INTO bio_edges (from_id, predicate, to_id) VALUES (?, ?, ?)", [from_id, predicate, to_id]);
  }
  return conn;
}

describe("entailed_edge: SemanticSQL closure over our own graph", () => {
  test("transitive closure makes descendants/subsumption a plain join, isolated per predicate", async () => {
    // a -is_a-> b -is_a-> c ; m -part_of-> n (a different transitive predicate)
    const conn = await graphConn([
      ["a", "rdfs:subClassOf", "b"],
      ["b", "rdfs:subClassOf", "c"],
      ["m", "BFO:0000050", "n"],
    ]);
    const n = await materializeEntailedEdges(conn, ["rdfs:subClassOf", "BFO:0000050"]);
    assert.equal(n, 4); // a->b, b->c, a->c (transitive), m->n

    // descendants of c under is-a == {a, b}, by a single indexed join — a is reachable transitively
    const desc = await conn.all<{ from_id: string }>("SELECT from_id FROM entailed_edge WHERE to_id = 'c' AND predicate = 'rdfs:subClassOf' ORDER BY from_id");
    assert.deepEqual(desc.map((r) => r.from_id), ["a", "b"]);

    // predicate isolation: the is-a closure never crosses into part_of (no a->n, no m under subClassOf)
    const cross = await conn.all<{ n: number }>("SELECT count(*) AS n FROM entailed_edge WHERE from_id = 'a' AND to_id = 'n'");
    assert.equal(Number(cross[0]!.n), 0);
  });

  test("cycles terminate (UNION dedups) and an empty predicate set yields an empty closure table", async () => {
    const cyclic = await graphConn([["x", "related_to", "y"], ["y", "related_to", "x"]]);
    const n = await materializeEntailedEdges(cyclic, ["related_to"]);
    // x->y, y->x, plus x->x and y->y — on a cycle each node is transitively reachable from itself (correct
    // transitive closure). UNION dedup is what makes the recursion terminate rather than loop forever.
    assert.equal(n, 4);
    const empty = await graphConn([["a", "rdfs:subClassOf", "b"]]);
    assert.equal(await materializeEntailedEdges(empty, []), 0);
  });

  test("supports qualified source/target tables and validates relation names early", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE SCHEMA kg");
    await conn.run("CREATE TABLE kg.bio_edges (from_id TEXT, to_id TEXT, predicate TEXT)");
    await conn.run("INSERT INTO kg.bio_edges VALUES ('a', 'b', 'rdfs:subClassOf')");
    await conn.run("INSERT INTO kg.bio_edges VALUES ('b', 'c', 'rdfs:subClassOf')");

    assert.equal(await materializeEntailedEdges(conn, ["rdfs:subClassOf"], { sourceTable: "kg.bio_edges", targetTable: "kg.entailed_edge" }), 3);
    assert.deepEqual(
      await conn.all<{ to_id: string }>("SELECT to_id FROM kg.entailed_edge WHERE from_id = 'a' ORDER BY to_id"),
      [{ to_id: "b" }, { to_id: "c" }],
    );
    await assert.rejects(
      () => materializeEntailedEdges(conn, ["rdfs:subClassOf"], { sourceTable: "kg.bio_edges;DROP", targetTable: "kg.entailed_edge" }),
      /sourceTable 'kg\.bio_edges;DROP' must be a SQL identifier or qualified identifier/,
    );
  });
});
