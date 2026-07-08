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
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:label',NULL,'asthma disorder',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','IAO:0000115',NULL,'A chronic respiratory disorder.',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','oio:hasExactSynonym',NULL,'bronchial asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','skos:hasExactMatch','UMLS:C0004096',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:seeAlso','PMID:1',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:seeAlso',NULL,' note with whitespace ','xsd:string',NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:label',NULL,'allergic asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','owl:deprecated',NULL,'true',NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004766','rdf:type','owl:Class',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('GO:0000001','rdf:type','owl:Class',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdf:type','GO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('RO:0002202','rdfs:subPropertyOf','RO:0000052',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('RO:0002202','rdfs:domain','MONDO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('RO:0002202','rdfs:range','MONDO:0000002',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction1','owl:onProperty','BFO:0000050',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction1','owl:someValuesFrom','GO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:subClassOf','_:restriction1',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list1','rdf:first','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list1','rdf:rest','_:list2',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list2','rdf:first','MONDO:0004784',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list2','rdf:rest','rdf:nil',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedSource','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedProperty','rdfs:subClassOf',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedTarget','MONDO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','oio:hasDbXref','GO_REF:0000002',NULL,NULL,NULL)");

    const views = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      targets: { edgeTable: "semantic_edge", termsTable: "semantic_terms" },
    });
    assert.equal(views.edgeTable, "semantic_edge");
    assert.equal(views.rdfListMemberTable, "rdf_list_member_statement");
    assert.equal(views.owlSubclassOfSomeValuesFromTable, "owl_subclass_of_some_values_from");
    assert.equal(views.axiomDbxrefAnnotationTable, "axiom_dbxref_annotation");
    assert.equal(views.trailingWhitespaceProblemTable, "trailing_whitespace_problem");
    assert.equal(views.propertyUsedWithDatatypeValuesAndObjectsTable, "property_used_with_datatype_values_and_objects");
    assert.equal(views.nodeWithTwoLabelsProblemTable, "node_with_two_labels_problem");
    assert.equal(views.allProblemsTable, "all_problems");
    assert.equal(views.termsTable, "semantic_terms");

    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM has_text_definition_statement"), [
      { subject: "MONDO:0004979", value: "A chronic respiratory disorder." },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM mapping_statement WHERE subject = 'MONDO:0004979'",
    ), [
      { subject: "MONDO:0004979", object: "UMLS:C0004096" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM rdf_type_statement WHERE subject = 'MONDO:0004766'",
    ), [
      { subject: "MONDO:0004766", object: "owl:Class" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM rdfs_subproperty_of_statement"), [
      { subject: "RO:0002202", object: "RO:0000052" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM rdfs_domain_statement"), [
      { subject: "RO:0002202", object: "MONDO:0000001" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM rdfs_range_statement"), [
      { subject: "RO:0002202", object: "MONDO:0000002" },
    ]);
    assert.deepEqual(await conn.all<{ id: string }>("SELECT id FROM deprecated_node"), [{ id: "MONDO:0004784" }]);
    assert.deepEqual(await conn.all<{ id: string; prefix: string; local_identifier: string }>(
      "SELECT id, prefix, local_identifier FROM node_identifier WHERE id = 'MONDO:0004979'",
    ), [{ id: "MONDO:0004979", prefix: "MONDO", local_identifier: "0004979" }]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM rdf_list_member_statement WHERE subject = '_:list1' ORDER BY object",
    ), [
      { subject: "_:list1", object: "MONDO:0004784" },
      { subject: "_:list1", object: "MONDO:0004979" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM owl_subclass_of_some_values_from",
    ), [{ subject: "MONDO:0004979", predicate: "BFO:0000050", object: "GO:0000001" }]);
    assert.deepEqual(await conn.all<{ annotation_subject: string; annotation_predicate: string; annotation_object: string }>(
      "SELECT annotation_subject, annotation_predicate, annotation_object FROM axiom_dbxref_annotation",
    ), [{ annotation_subject: "_:axiom1", annotation_predicate: "oio:hasDbXref", annotation_object: "GO_REF:0000002" }]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; value: string }>(
      "SELECT subject, predicate, value FROM trailing_whitespace_problem",
    ), [{ subject: "MONDO:0004979", predicate: "rdfs:seeAlso", value: " note with whitespace " }]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; value: string }>(
      "SELECT subject, predicate, value FROM property_used_with_datatype_values_and_objects",
    ), [{ subject: "rdfs:seeAlso", predicate: "rdfs:seeAlso", value: "xsd:string" }]);
    assert.deepEqual(await conn.all<{ value: string }>(
      "SELECT value FROM node_with_two_labels_problem WHERE subject = 'MONDO:0004979' ORDER BY value",
    ), [{ value: "asthma" }, { value: "asthma disorder" }]);
    assert.deepEqual(await conn.all<{ predicate: string; value: string }>(
      "SELECT predicate, value FROM all_problems WHERE subject = 'rdfs:seeAlso'",
    ), []);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM semantic_edge WHERE subject = 'MONDO:0004979' ORDER BY predicate, object",
    ), [
      { subject: "MONDO:0004979", predicate: "BFO:0000050", object: "GO:0000001" },
      { subject: "MONDO:0004979", predicate: "rdf:type", object: "GO:0000001" },
    ]);

    const terms = await conn.all<{ id: string; label: string; definition: string; deprecated: boolean; synonyms_json: string }>(
      "SELECT id, label, definition, deprecated, to_json(synonyms)::VARCHAR AS synonyms_json FROM semantic_terms WHERE id = 'MONDO:0004979'",
    );
    assert.equal(terms[0]!.label, "asthma");
    assert.equal(terms[0]!.definition, "A chronic respiratory disorder.");
    assert.equal(terms[0]!.deprecated, false);
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
    assert.deepEqual(out, { edgesTable: "semantic_bio_edges", edgeCount: 5, closureTable: "semantic_entailed_edge", closureCount: 3 });
    const ancestors = await conn.all<{ to_id: string }>(
      "SELECT to_id FROM semantic_entailed_edge WHERE from_id = 'MONDO:0004766' ORDER BY to_id",
    );
    assert.deepEqual(ancestors.map((x) => x.to_id), ["MONDO:0004784", "MONDO:0004979"]);
  });

  test("canonicalizes SemanticSQL IRI statements through a prefix table before graph projection", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE statements(subject TEXT, predicate TEXT, object TEXT, value TEXT, datatype TEXT, language TEXT)");
    await conn.run("CREATE TABLE prefix(prefix TEXT, base TEXT)");
    await conn.run("INSERT INTO prefix VALUES ('OBO','http://purl.obolibrary.org/obo/')");
    await conn.run("INSERT INTO prefix VALUES ('MONDO','http://purl.obolibrary.org/obo/MONDO_')");
    await conn.run("INSERT INTO prefix VALUES ('IAO','http://purl.obolibrary.org/obo/IAO_')");
    await conn.run("INSERT INTO prefix VALUES ('owl','http://www.w3.org/2002/07/owl#')");
    await conn.run("INSERT INTO prefix VALUES ('rdfs','http://www.w3.org/2000/01/rdf-schema#')");
    await conn.run("INSERT INTO prefix VALUES ('oio','http://www.geneontology.org/formats/oboInOwl#')");
    await conn.run("INSERT INTO prefix VALUES ('EMPTY','')");
    await conn.run("INSERT INTO prefix VALUES (NULL,'http://purl.obolibrary.org/obo/HP_')");
    await conn.run("INSERT INTO prefix VALUES ('BAD',NULL)");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004979','http://www.w3.org/2000/01/rdf-schema#label',NULL,'asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004979','http://purl.obolibrary.org/obo/IAO_0000115',NULL,'A chronic respiratory disorder.',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004979','http://www.geneontology.org/formats/oboInOwl#hasExactSynonym',NULL,'bronchial asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004979','http://www.w3.org/2002/07/owl#deprecated',NULL,'true',NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004784','http://www.w3.org/2000/01/rdf-schema#subClassOf','http://purl.obolibrary.org/obo/MONDO_0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004766','http://www.w3.org/2000/01/rdf-schema#subClassOf','http://purl.obolibrary.org/obo/MONDO_0004784',NULL,NULL,NULL)");

    await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      prefixTable: "prefix",
      targets: { edgeTable: "iri_edge", labelsTable: "iri_label", definitionsTable: "iri_definition", synonymsTable: "iri_synonym", termsTable: "iri_terms" },
    });

    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM iri_edge ORDER BY subject",
    ), [
      { subject: "MONDO:0004766", predicate: "rdfs:subClassOf", object: "MONDO:0004784" },
      { subject: "MONDO:0004784", predicate: "rdfs:subClassOf", object: "MONDO:0004979" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_label"), [
      { subject: "MONDO:0004979", value: "asthma" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_definition"), [
      { subject: "MONDO:0004979", value: "A chronic respiratory disorder." },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_synonym"), [
      { subject: "MONDO:0004979", value: "bronchial asthma" },
    ]);
    assert.deepEqual(
      await conn.all<{ id: string; definition: string; deprecated: boolean }>(
        "SELECT id, definition, deprecated FROM iri_terms WHERE id = 'MONDO:0004979'",
      ),
      [{ id: "MONDO:0004979", definition: "A chronic respiratory disorder.", deprecated: true }],
    );

    const out = await materializeGraphProjectionProfile(conn, {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "semantic-sql-iri-source-spec-generated-edge",
      title: "SemanticSQL IRI source-spec generated edge projection",
      source: { kind: "semantic_sql", table: "iri_edge" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
      closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
      target: { edgesTable: "iri_bio_edges", closureTable: "iri_entailed_edge" },
    });
    assert.deepEqual(out, { edgesTable: "iri_bio_edges", edgeCount: 2, closureTable: "iri_entailed_edge", closureCount: 3 });
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

  test("materializes a declared upstream SemanticSQL entailed_edge artifact", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE edge_raw (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO edge_raw VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO edge_raw VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("CREATE TABLE precomputed_entailed_edge (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO precomputed_entailed_edge VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO precomputed_entailed_edge VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO precomputed_entailed_edge VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO precomputed_entailed_edge VALUES ('MONDO:0004766','BFO:0000050','UBERON:0001004')");

    const externalArtifactClosure: GraphProjectionProfile = {
      ...profile,
      id: "external-artifact-closure",
      source: { kind: "external_kg", table: "edge_raw" },
      target: { edgesTable: "artifact_closure_edges", closureTable: "artifact_closure_entailed" },
      closure: {
        source: "upstream_entailed_edge",
        transitivePredicates: ["rdfs:subClassOf"],
        artifactTable: "precomputed_entailed_edge",
      },
    };

    const out = await materializeGraphProjectionProfile(conn, externalArtifactClosure);
    assert.deepEqual(out, { edgesTable: "artifact_closure_edges", edgeCount: 2, closureTable: "artifact_closure_entailed", closureCount: 3 });
    assert.deepEqual(
      await conn.all<{ to_id: string }>(
        "SELECT to_id FROM artifact_closure_entailed WHERE from_id = 'MONDO:0004766' AND predicate = 'rdfs:subClassOf' ORDER BY to_id",
      ),
      [{ to_id: "MONDO:0004784" }, { to_id: "MONDO:0004979" }],
    );
    assert.deepEqual(await conn.all<{ n: bigint }>("SELECT count(*) AS n FROM artifact_closure_entailed WHERE predicate = 'BFO:0000050'"), [{ n: 0n }]);
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
