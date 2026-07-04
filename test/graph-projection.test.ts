import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { graphProjectionSql, validateGraphProjectionProfile, type GraphProjectionProfile } from "../src/core/graph-projection.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";

const profile: GraphProjectionProfile = {
  schema: "pi-bio.graph_projection_profile.v1",
  id: "semantic-sql-edge",
  title: "SemanticSQL edge projection",
  source: { kind: "semantic_sql", table: "edge_raw" },
  columns: { from: "subject", predicate: "predicate", to: "object" },
  curiePrefixes: [
    { prefix: "MONDO", base: "http://purl.obolibrary.org/obo/MONDO_" },
    { prefix: "rdfs", base: "http://www.w3.org/2000/01/rdf-schema#" },
  ],
  generatedViews: { edge: "semantic_sql", labels: "statements", synonyms: "statements" },
  closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
  target: { edgesTable: "bio_edges", temporal: { kind: "atemporal" } },
  provenance: [{ source: "test-fixture", license: "CC0", deid: "not_applicable" }],
};

describe("graph projection profile: source relation -> compiled graph", () => {
  test("validates a SemanticSQL-shaped projection profile and projects with one generated SQL statement", async () => {
    assert.deepEqual(validateGraphProjectionProfile(profile), []);
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE edge_raw (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO edge_raw VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO edge_raw VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");

    assert.throws(() => graphProjectionSql(profile), /caller must handle profile policy fields separately/);
    await conn.run(graphProjectionSql(profile, { allowPolicyFields: true }));
    const direct = await conn.all<{ from_id: string; predicate: string; to_id: string }>("SELECT from_id, predicate, to_id FROM bio_edges ORDER BY from_id");
    assert.deepEqual(direct.map((r) => [r.from_id, r.predicate, r.to_id]), [
      ["MONDO:0004766", "rdfs:subClassOf", "MONDO:0004784"],
      ["MONDO:0004784", "rdfs:subClassOf", "MONDO:0004979"],
    ]);

    assert.equal(await materializeEntailedEdges(conn, profile.closure?.transitivePredicates ?? []), 3);
    const reach = await conn.all<{ to_id: string }>("SELECT to_id FROM entailed_edge WHERE from_id='MONDO:0004766' ORDER BY to_id");
    assert.deepEqual(reach.map((r) => r.to_id), ["MONDO:0004784", "MONDO:0004979"]);
  });

  test("fails closed on ambiguous source shape and duplicate CURIE-prefix bindings", () => {
    const bad = {
      ...profile,
      source: { ...profile.source, fallbackTable: "edge" },
      curiePrefixes: [{ prefix: "HP", base: "x:" }, { prefix: "HP", base: "y:" }],
    } as unknown as GraphProjectionProfile;
    const errors = validateGraphProjectionProfile(bad);
    assert.ok(errors.some((e) => e.includes("unknown key 'fallbackTable'")));
    assert.ok(errors.some((e) => e.includes("prefix 'HP' is duplicated")));
    assert.throws(() => graphProjectionSql(bad), /invalid graph projection profile/);
  });

  test("the same profile shape covers internal temporal projections", () => {
    const internal: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "observations-as-of",
      title: "Observation graph as of time",
      source: { kind: "observations", table: "bio_edges_as_of" },
      columns: { from: "from_id", predicate: "predicate", to: "to_id", attrs: "attrs", trust: "trust" },
      target: { edgesTable: "bio_edges_window", temporal: { kind: "as_of", asOf: "2026-07-04T00:00:00Z" } },
      closure: { source: "local_cte", transitivePredicates: ["references"] },
    };
    assert.deepEqual(validateGraphProjectionProfile(internal), []);
    assert.throws(() => graphProjectionSql(internal), /caller must handle profile policy fields separately/);
    assert.match(graphProjectionSql(internal, { allowPolicyFields: true }), /CREATE OR REPLACE TABLE "bio_edges_window"/);
  });
});
