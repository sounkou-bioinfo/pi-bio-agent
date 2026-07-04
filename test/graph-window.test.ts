import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { queryGraphWindow } from "../src/duckdb/graph-window.js";

describe("graph query windows: bounded graph context over compiled graph tables", () => {
  test("returns a bounded page, omitted count, and continuation handle for a high-degree node", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE bio_edges (from_id TEXT, predicate TEXT, to_id TEXT)");
    for (const to of ["b", "c", "d", "e"]) await conn.run("INSERT INTO bio_edges VALUES ('a','related_to',?)", [to]);

    const window = await queryGraphWindow(conn, { startId: "a", limit: 2 });
    assert.equal(window.totalCount, 4);
    assert.equal(window.rows.length, 2);
    assert.equal(window.omittedCount, 2);
    assert.equal(window.continuation?.mode, "virtual");
    assert.match(window.continuation?.pointer?.uri ?? "", /^graph-window:/);
    assert.match(window.continuation?.pointer?.uri ?? "", /startId=a/);

    const next = await queryGraphWindow(conn, { startId: "a", limit: 2, offset: 2 });
    assert.deepEqual(next.rows.map((r) => r.to_id), ["d", "e"]);
    assert.equal(next.omittedCount, 0);
    assert.equal(next.continuation, undefined);
  });

  test("filters by direction and predicate without a custom graph runtime", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE entailed_edge_as_of (from_id TEXT, predicate TEXT, to_id TEXT)");
    await conn.run("INSERT INTO entailed_edge_as_of VALUES ('child','rdfs:subClassOf','root')");
    await conn.run("INSERT INTO entailed_edge_as_of VALUES ('sibling','related_to','root')");
    await conn.run("INSERT INTO entailed_edge_as_of VALUES ('root','references','note')");

    const incoming = await queryGraphWindow(conn, {
      table: "entailed_edge_as_of",
      startId: "root",
      direction: "in",
      predicates: ["rdfs:subClassOf"],
      limit: 10,
    });
    assert.deepEqual(incoming.rows.map((r) => [r.from_id, r.predicate, r.to_id]), [["child", "rdfs:subClassOf", "root"]]);

    const both = await queryGraphWindow(conn, { table: "entailed_edge_as_of", startId: "root", direction: "both", limit: 10 });
    assert.equal(both.totalCount, 3);
  });

  test("fails closed on unsafe table names and unbounded limits", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await assert.rejects(() => queryGraphWindow(conn, { table: "bio_edges;DROP", startId: "a" }), /SQL identifier/);
    await assert.rejects(() => queryGraphWindow(conn, { startId: "a", limit: 0 }), /limit/);
  });
});
