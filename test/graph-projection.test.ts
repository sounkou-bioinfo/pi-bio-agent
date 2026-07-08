import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { graphProjectionSql, validateGraphProjectionProfile, type GraphProjectionProfile } from "../src/core/graph-projection.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";
import { materializeGraphProjectionProfile } from "../src/duckdb/graph-projection.js";
import { materializeSemanticSqlSourceViews, semanticSqlSourceViewSql, SEMANTIC_SQL_SOURCE_SPEC_SCHEMA } from "../src/duckdb/semantic-sql.js";
import { createBioObservationSchema, materializeBioEdgesAsOf, recordObservationLink } from "../src/duckdb/observations.js";

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
  test("materializes SemanticSQL source-spec views from statements, then projects generated edge into bio_edges", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE statements(subject TEXT, predicate TEXT, object TEXT, value TEXT, datatype TEXT, language TEXT)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:label',NULL,'asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','oio:hasExactSynonym',NULL,'bronchial asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:label',NULL,'allergic asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979',NULL,NULL,NULL)");

    const views = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      targets: { edgeTable: "semantic_edge", termsTable: "semantic_terms" },
    });
    assert.deepEqual(views, {
      edgeTable: "semantic_edge",
      labelsTable: "rdfs_label_statement",
      synonymsTable: "synonym_statement",
      mappingsTable: "mapping_statement",
      termsTable: "semantic_terms",
    });

    const terms = await conn.all<{ id: string; label: string; synonyms_json: string }>(
      "SELECT id, label, to_json(synonyms)::VARCHAR AS synonyms_json FROM semantic_terms WHERE id = 'MONDO:0004979'",
    );
    assert.equal(terms[0]!.label, "asthma");
    assert.deepEqual(JSON.parse(terms[0]!.synonyms_json), ["bronchial asthma"]);

    const sourceSpecProfile: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "semantic-sql-source-spec-generated-edge",
      title: "SemanticSQL source-spec generated edge projection",
      source: { kind: "semantic_sql", table: "semantic_edge" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
      closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
      target: { edgesTable: "semantic_bio_edges", closureTable: "semantic_entailed_edge" },
    };

    const out = await materializeGraphProjectionProfile(conn, sourceSpecProfile);
    assert.deepEqual(out, { edgesTable: "semantic_bio_edges", edgeCount: 2, closureTable: "semantic_entailed_edge", closureCount: 3 });
    const ancestors = await conn.all<{ to_id: string }>(
      "SELECT to_id FROM semantic_entailed_edge WHERE from_id = 'MONDO:0004766' ORDER BY to_id",
    );
    assert.deepEqual(ancestors.map((x) => x.to_id), ["MONDO:0004784", "MONDO:0004979"]);
  });

  test("SemanticSQL source-spec view generation fails closed on invalid predicate lists", () => {
    assert.throws(
      () => semanticSqlSourceViewSql({ schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA, predicates: { labels: [] } }),
      /at least one non-empty string/,
    );
  });

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

  test("materializes a real external KG fixture through a profile and closes it locally", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE ontology_edge_raw AS SELECT * FROM read_csv_auto('test/fixtures/ontology_edges.csv')");

    const external: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "mondo-fixture-profile",
      title: "MONDO fixture graph projection",
      source: { kind: "external_kg", table: "ontology_edge_raw" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
      curiePrefixes: [{ prefix: "MONDO", base: "http://purl.obolibrary.org/obo/MONDO_" }],
      closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
      target: { edgesTable: "external_kg_edges", closureTable: "external_kg_entailed" },
      provenance: [{ source: "test/fixtures/ontology_edges.csv", license: "fixture", deid: "not_applicable" }],
    };

    const out = await materializeGraphProjectionProfile(conn, external);
    assert.deepEqual(out, { edgesTable: "external_kg_edges", edgeCount: 3, closureTable: "external_kg_entailed", closureCount: 4 });
    const desc = await conn.all<{ from_id: string }>(
      "SELECT from_id FROM external_kg_entailed WHERE to_id = 'MONDO:0004979' AND predicate = 'rdfs:subClassOf' ORDER BY from_id",
    );
    assert.deepEqual(desc.map((x) => x.from_id), ["MONDO:0004766", "MONDO:0004784", "MONDO:0005405"]);
  });

  test("materializer fails closed when closure is declared as a non-local artifact", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE edge_raw (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO edge_raw VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");

    const externalArtifactClosure: GraphProjectionProfile = {
      ...profile,
      id: "external-artifact-closure",
      source: { kind: "external_kg", table: "edge_raw" },
      target: { edgesTable: "artifact_closure_edges", closureTable: "artifact_closure_entailed" },
      closure: {
        source: "relation_graph_artifact",
        transitivePredicates: ["rdfs:subClassOf"],
        artifactTable: "precomputed_entailed_edge",
      },
    };

    await assert.rejects(
      () => materializeGraphProjectionProfile(conn, externalArtifactClosure),
      /closure source 'relation_graph_artifact' is not locally materializable/,
    );
  });

  test("materializes the internal observation graph through the same profile path", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const now = "2026-07-06T12:00:00.000Z";
    await createBioObservationSchema(conn);
    await recordObservationLink(conn, { subjectId: "workflow:w1:step:score", predicate: "depends_on", objectId: "workflow:w1:step:load", recordedAt: now, source: "test" });
    await recordObservationLink(conn, { subjectId: "workflow:w1:step:report", predicate: "depends_on", objectId: "workflow:w1:step:score", recordedAt: now, source: "test" });
    await recordObservationLink(conn, { subjectId: "toolcall:s1:tc1", predicate: "executes", objectId: "run:q1", recordedAt: now, source: "test" });
    await materializeBioEdgesAsOf(conn, "2026-07-06T12:00:01.000Z");

    const internal: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "internal-observation-profile",
      title: "Internal observation graph projection",
      source: { kind: "observations", table: "bio_edges_as_of" },
      columns: { from: "from_id", predicate: "predicate", to: "to_id", attrs: "attrs", trust: "trust" },
      closure: { source: "local_cte", transitivePredicates: ["depends_on"] },
      target: {
        edgesTable: "internal_profile_edges",
        closureTable: "internal_profile_entailed",
        temporal: { kind: "as_of", asOf: "2026-07-06T12:00:01.000Z" },
      },
      provenance: [{ source: "bio_observations", deid: "unknown" }],
    };

    const out = await materializeGraphProjectionProfile(conn, internal);
    assert.deepEqual(out, { edgesTable: "internal_profile_edges", edgeCount: 3, closureTable: "internal_profile_entailed", closureCount: 3 });
    const projected = await conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM internal_profile_edges ORDER BY predicate, from_id",
    );
    assert.ok(projected.some((x) => x.from_id === "toolcall:s1:tc1" && x.predicate === "executes" && x.to_id === "run:q1"), "non-transitive run links still project as graph edges");
    const closure = await conn.all<{ to_id: string }>(
      "SELECT to_id FROM internal_profile_entailed WHERE from_id = 'workflow:w1:step:report' AND predicate = 'depends_on' ORDER BY to_id",
    );
    assert.deepEqual(closure.map((x) => x.to_id), ["workflow:w1:step:load", "workflow:w1:step:score"]);
  });
});
