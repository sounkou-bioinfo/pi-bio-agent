import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { graphProjectionSql, validateGraphProjectionProfile, type GraphProjectionProfile } from "../src/core/graph-projection.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";
import { materializeGraphProjectionProfile } from "../src/duckdb/graph-projection.js";
import { materializeSemanticSqlSourceViews, semanticSqlSourceViewSql, SEMANTIC_SQL_SOURCE_SPEC_SCHEMA, SEMANTIC_SQL_UPSTREAM_COMPATIBILITY } from "../src/duckdb/semantic-sql.js";
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
    await conn.run("INSERT INTO statements VALUES ('RO:0000052','rdfs:subPropertyOf','RO:0000000',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('RO:0002202','rdfs:domain','MONDO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('RO:0002202','rdfs:range','MONDO:0000002',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction1','owl:onProperty','BFO:0000050',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction1','owl:someValuesFrom','GO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:subClassOf','_:restriction1',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction2','owl:onProperty','BFO:0000051',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction2','owl:someValuesFrom','UBERON:0001004',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:subClassOf','_:restriction2',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_subprop','owl:onProperty','RO:0002202',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_subprop','owl:someValuesFrom','GO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:subClassOf','_:restriction_subprop',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_taxon','owl:onProperty','RO:0002162',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_taxon','owl:someValuesFrom','NCBITaxon:9606',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','rdfs:subClassOf','_:restriction_taxon',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_taxon_broad','owl:onProperty','RO:0002162',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_taxon_broad','owl:someValuesFrom','NCBITaxon:1',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004784','rdfs:subClassOf','_:restriction_taxon_broad',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('MONDO:0004979','RO:0002161','NCBITaxon:7955',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_acid','owl:onProperty','obo:chebi#is_conjugate_acid_of',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_acid','owl:someValuesFrom','CHEBI:15378',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('CHEBI:15377','rdfs:subClassOf','_:restriction_acid',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_base','owl:onProperty','obo:chebi#is_conjugate_base_of',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:restriction_base','owl:someValuesFrom','CHEBI:15379',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('CHEBI:15378','rdfs:subClassOf','_:restriction_base',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('CHEBI:15377','obo:chebi/charge',NULL,'-1','xsd:int',NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list1','rdf:first','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list1','rdf:rest','_:list2',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list2','rdf:first','MONDO:0004784',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:list2','rdf:rest','rdf:nil',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedSource','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedProperty','rdfs:subClassOf',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','owl:annotatedTarget','MONDO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom1','oio:hasDbXref','GO_REF:0000002',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom_edge','owl:annotatedSource','MONDO:0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom_edge','owl:annotatedProperty','BFO:0000050',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom_edge','owl:annotatedTarget','GO:0000001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom_edge','oio:hasDbXref','PMID:EDGE1',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('_:axiom_edge','rdfs:comment',NULL,'curated edge evidence',NULL,'en')");
    await conn.run("CREATE TABLE semantic_entailed_input(subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:0004979','rdf:type','GO:0000001')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('NCBITaxon:9606','rdfs:subClassOf','NCBITaxon:1')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('NCBITaxon:7955','rdfs:subClassOf','NCBITaxon:1')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('NCBITaxon:7956','rdfs:subClassOf','NCBITaxon:7955')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('NCBITaxon:7956','rdfs:subClassOf','NCBITaxon:1')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:cycleA','rdfs:subClassOf','MONDO:cycleB')");
    await conn.run("INSERT INTO semantic_entailed_input VALUES ('MONDO:cycleB','rdfs:subClassOf','MONDO:cycleA')");
    await conn.run("CREATE TABLE raw_term_association(id TEXT, subject TEXT, predicate TEXT, object TEXT, evidence_type TEXT, publication TEXT, source TEXT)");
    await conn.run("INSERT INTO raw_term_association VALUES ('assoc:1','case:1','RO:0002200','HP:0001250','ECO:0000269','PMID:1','fixture')");

    const views = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      entailedEdgeTable: "semantic_entailed_input",
      termAssociationSourceTable: "raw_term_association",
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
    assert.equal(views.partOfEdgeTable, "part_of_edge");
    assert.equal(views.hasPartEdgeTable, "has_part_edge");
    assert.equal(views.edgeBySuperpropertyTable, "edge_by_superproperty");
    assert.equal(views.edgeWithMetadataTable, "edge_with_metadata");
    assert.equal(views.conjugateAcidOfEdgeTable, "conjugate_acid_of_edge");
    assert.equal(views.conjugateBaseOfEdgeTable, "conjugate_base_of_edge");
    assert.equal(views.chargeStatementTable, "charge_statement");
    assert.equal(views.subgraphEdgeByParentTable, "subgraph_edge_by_parent");
    assert.equal(views.subgraphEdgeByChildTable, "subgraph_edge_by_child");
    assert.equal(views.subgraphEdgeBySelfTable, "subgraph_edge_by_self");
    assert.equal(views.subgraphEdgeByAncestorTable, "subgraph_edge_by_ancestor");
    assert.equal(views.subgraphEdgeByDescendantTable, "subgraph_edge_by_descendant");
    assert.equal(views.subgraphEdgeByAncestorOrDescendantTable, "subgraph_edge_by_ancestor_or_descendant");
    assert.equal(views.entailedSubclassOfEdgeTable, "entailed_subclass_of_edge");
    assert.equal(views.entailedTypeEdgeTable, "entailed_type_edge");
    assert.equal(views.entailedEdgeCycleTable, "entailed_edge_cycle");
    assert.equal(views.entailedEdgeSamePredicateCycleTable, "entailed_edge_same_predicate_cycle");
    assert.equal(views.transitiveEdgeTable, "transitive_edge");
    assert.equal(views.taxonTable, "taxon");
    assert.equal(views.directNeverInTaxonTable, "direct_never_in_taxon");
    assert.equal(views.directInTaxonTable, "direct_in_taxon");
    assert.equal(views.inferredNeverInTaxonDirectTable, "inferred_never_in_taxon_direct");
    assert.equal(views.inferredInTaxonDirectTable, "inferred_in_taxon_direct");
    assert.equal(views.inferredNeverInTaxon1Table, "inferred_never_in_taxon_1");
    assert.equal(views.inferredNeverInTaxon2Table, "inferred_never_in_taxon_2");
    assert.equal(views.inferredNeverInTaxonTable, "inferred_never_in_taxon");
    assert.equal(views.mostSpecificInferredInTaxonTable, "most_specific_inferred_in_taxon");
    assert.equal(views.nodePairwiseOverlapTable, "node_pairwise_overlap");
    assert.equal(views.termAssociationTable, "term_association");
    assert.equal(views.termsTable, "semantic_terms");

    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM has_text_definition_statement"), [
      { subject: "MONDO:0004979", value: "A chronic respiratory disorder." },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM has_mapping_statement WHERE subject = 'MONDO:0004979'",
    ), [
      { subject: "MONDO:0004979", object: "UMLS:C0004096" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM rdf_type_statement WHERE subject = 'MONDO:0004766'",
    ), [
      { subject: "MONDO:0004766", object: "owl:Class" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM rdfs_subproperty_of_statement ORDER BY subject, object"), [
      { subject: "RO:0000052", object: "RO:0000000" },
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
      "SELECT subject, predicate, object FROM owl_subclass_of_some_values_from ORDER BY subject, predicate, object",
    ), [
      { subject: "CHEBI:15377", predicate: "obo:chebi#is_conjugate_acid_of", object: "CHEBI:15378" },
      { subject: "CHEBI:15378", predicate: "obo:chebi#is_conjugate_base_of", object: "CHEBI:15379" },
      { subject: "MONDO:0004784", predicate: "RO:0002162", object: "NCBITaxon:1" },
      { subject: "MONDO:0004979", predicate: "BFO:0000050", object: "GO:0000001" },
      { subject: "MONDO:0004979", predicate: "BFO:0000051", object: "UBERON:0001004" },
      { subject: "MONDO:0004979", predicate: "RO:0002162", object: "NCBITaxon:9606" },
      { subject: "MONDO:0004979", predicate: "RO:0002202", object: "GO:0000001" },
    ]);
    assert.deepEqual(await conn.all<{ annotation_subject: string; annotation_predicate: string; annotation_object: string }>(
      "SELECT annotation_subject, annotation_predicate, annotation_object FROM axiom_dbxref_annotation ORDER BY annotation_subject",
    ), [
      { annotation_subject: "_:axiom1", annotation_predicate: "oio:hasDbXref", annotation_object: "GO_REF:0000002" },
      { annotation_subject: "_:axiom_edge", annotation_predicate: "oio:hasDbXref", annotation_object: "PMID:EDGE1" },
    ]);
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
    const [edgeMetadata] = await conn.all<{ attrs: string; trust: string }>(
      "SELECT attrs::VARCHAR AS attrs, trust::VARCHAR AS trust FROM edge_with_metadata WHERE subject = 'MONDO:0004979' AND predicate = 'BFO:0000050' AND object = 'GO:0000001'",
    );
    assert.ok(edgeMetadata);
    const edgeAttrs = JSON.parse(edgeMetadata!.attrs) as { axiom_annotations: Array<Record<string, unknown>>; source_problems: Array<Record<string, unknown>> };
    const edgeTrust = JSON.parse(edgeMetadata!.trust) as { evidence_xrefs: string[]; source_problem_count: number };
    assert.ok(edgeAttrs.axiom_annotations.some((x) => x.annotation_object === "PMID:EDGE1"));
    assert.ok(edgeAttrs.axiom_annotations.some((x) => x.annotation_value === "curated edge evidence"));
    assert.equal(edgeAttrs.source_problems.filter((x) => x.problem_subject === "MONDO:0004979").length, 3);
    assert.deepEqual(edgeTrust.evidence_xrefs, ["PMID:EDGE1"]);
    assert.equal(edgeTrust.source_problem_count, 3);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM part_of_edge"), [
      { subject: "MONDO:0004979", object: "GO:0000001" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM has_part_edge"), [
      { subject: "MONDO:0004979", object: "UBERON:0001004" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string; source_predicate: string }>(
      "SELECT subject, predicate, object, source_predicate FROM edge_by_superproperty WHERE subject = 'MONDO:0004979' ORDER BY predicate, object, source_predicate",
    ), [
      { subject: "MONDO:0004979", predicate: "RO:0000000", object: "GO:0000001", source_predicate: "RO:0002202" },
      { subject: "MONDO:0004979", predicate: "RO:0000052", object: "GO:0000001", source_predicate: "RO:0002202" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM conjugate_acid_of_edge"), [
      { subject: "CHEBI:15377", object: "CHEBI:15378" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>("SELECT subject, object FROM conjugate_base_of_edge"), [
      { subject: "CHEBI:15378", object: "CHEBI:15379" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; value: number }>("SELECT subject, predicate, value FROM charge_statement"), [
      { subject: "CHEBI:15377", predicate: "obo:chebi/charge", value: -1 },
    ]);
    assert.deepEqual(
      await conn.all<{ anchor_predicate: string; anchor_object: string }>(
        "SELECT anchor_predicate, anchor_object FROM subgraph_edge_by_self WHERE subject = 'MONDO:0004979' AND predicate = 'BFO:0000051'",
      ),
      [{ anchor_predicate: "BFO:0000051", anchor_object: "MONDO:0004979" }],
    );
    assert.deepEqual(await conn.all<{ object: string }>(
      "SELECT object FROM entailed_subclass_of_edge WHERE subject = 'MONDO:0004766' ORDER BY object",
    ), [{ object: "MONDO:0004784" }, { object: "MONDO:0004979" }]);
    assert.deepEqual(await conn.all<{ object: string }>("SELECT object FROM entailed_type_edge WHERE subject = 'MONDO:0004979'"), [{ object: "GO:0000001" }]);
    assert.deepEqual(await conn.all<{ object: string; depth: number }>(
      "SELECT object, CAST(depth AS INTEGER) AS depth FROM transitive_edge WHERE subject = 'MONDO:0004766' AND predicate = 'rdfs:subClassOf' ORDER BY depth, object",
    ), [{ object: "MONDO:0004784", depth: 1 }, { object: "MONDO:0004979", depth: 2 }]);
    assert.deepEqual(
      await conn.all<{ anchor_object: string }>(
        "SELECT DISTINCT anchor_object FROM subgraph_edge_by_ancestor WHERE subject = 'MONDO:0004766' AND predicate = 'rdfs:subClassOf' ORDER BY anchor_object",
      ),
      [{ anchor_object: "MONDO:0004784" }, { anchor_object: "MONDO:0004979" }],
    );
    assert.deepEqual(
      await conn.all<{ anchor_object: string }>(
        "SELECT DISTINCT anchor_object FROM subgraph_edge_by_descendant WHERE subject = 'MONDO:0004784' AND predicate = 'rdfs:subClassOf'",
      ),
      [{ anchor_object: "MONDO:0004766" }],
    );
    assert.deepEqual(
      await conn.all<{ object: string; secondary_predicate: string }>(
        "SELECT object, secondary_predicate FROM entailed_edge_same_predicate_cycle WHERE subject = 'MONDO:cycleA'",
      ),
      [{ object: "MONDO:cycleB", secondary_predicate: "rdfs:subClassOf" }],
    );
    assert.deepEqual(await conn.all<{ id: string }>("SELECT id FROM taxon ORDER BY id"), [
      { id: "NCBITaxon:7955" },
      { id: "NCBITaxon:7956" },
      { id: "NCBITaxon:9606" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM direct_in_taxon ORDER BY subject, object",
    ), [{ subject: "MONDO:0004784", object: "NCBITaxon:1" }, { subject: "MONDO:0004979", object: "NCBITaxon:9606" }]);
    assert.deepEqual(await conn.all<{ subject: string; object: string }>(
      "SELECT subject, object FROM direct_never_in_taxon",
    ), [{ subject: "MONDO:0004979", object: "NCBITaxon:7955" }]);
    assert.deepEqual(await conn.all<{ subject: string; node_with_constraint: string; taxon_with_constraint: string }>(
      "SELECT subject, node_with_constraint, taxon_with_constraint FROM inferred_in_taxon_direct WHERE subject = 'MONDO:0004766' ORDER BY taxon_with_constraint",
    ), [
      { subject: "MONDO:0004766", node_with_constraint: "MONDO:0004784", taxon_with_constraint: "NCBITaxon:1" },
      { subject: "MONDO:0004766", node_with_constraint: "MONDO:0004979", taxon_with_constraint: "NCBITaxon:9606" },
    ]);
    assert.deepEqual(await conn.all<{ taxon_with_constraint: string }>(
      "SELECT taxon_with_constraint FROM most_specific_inferred_in_taxon WHERE subject = 'MONDO:0004766'",
    ), [{ taxon_with_constraint: "NCBITaxon:9606" }]);
    assert.deepEqual(await conn.all<{ node1: string; node2: string; num_ancestors: number }>(
      "SELECT node1, node2, CAST(num_ancestors AS INTEGER) AS num_ancestors FROM node_pairwise_overlap WHERE node1 = 'MONDO:0004766' AND node2 = 'MONDO:0004784' AND predicate1 = 'rdfs:subClassOf' AND predicate2 = 'rdfs:subClassOf'",
    ), [{ node1: "MONDO:0004766", node2: "MONDO:0004784", num_ancestors: 1 }]);
    assert.deepEqual(await conn.all<{ num_ancestors: number }>(
      "SELECT CAST(num_ancestors AS INTEGER) AS num_ancestors FROM node_pairwise_overlap WHERE node1 = 'MONDO:0004766' AND node2 = 'MONDO:0004766' AND predicate1 = 'rdfs:subClassOf' AND predicate2 = 'rdfs:subClassOf'",
    ), [{ num_ancestors: 2 }]);
    assert.deepEqual(await conn.all<{
      id: string;
      subject: string;
      predicate: string;
      object: string;
      evidence_type: string;
      publication: string;
      source: string;
    }>(
      "SELECT id, subject, predicate, object, evidence_type, publication, source FROM term_association",
    ), [{
      id: "assoc:1",
      subject: "case:1",
      predicate: "RO:0002200",
      object: "HP:0001250",
      evidence_type: "ECO:0000269",
      publication: "PMID:1",
      source: "fixture",
    }]);
    const termAssociationColumns = await conn.all<{ column_name: string }>("DESCRIBE term_association");
    assert.deepEqual(termAssociationColumns.map((c) => c.column_name), [
      "id",
      "subject",
      "predicate",
      "object",
      "evidence_type",
      "publication",
      "source",
    ]);
    assert.deepEqual(await conn.all<{ query_taxon: string }>(
      "SELECT DISTINCT query_taxon FROM inferred_never_in_taxon_1 WHERE subject = 'MONDO:0004766' ORDER BY query_taxon",
    ), [{ query_taxon: "NCBITaxon:7955" }, { query_taxon: "NCBITaxon:7956" }]);
    assert.deepEqual(await conn.all<{ query_taxon: string }>(
      "SELECT DISTINCT query_taxon FROM inferred_never_in_taxon_2 WHERE subject = 'MONDO:0004766' ORDER BY query_taxon",
    ), [{ query_taxon: "NCBITaxon:7955" }, { query_taxon: "NCBITaxon:7956" }]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM semantic_edge WHERE subject = 'MONDO:0004979' ORDER BY predicate, object",
    ), [
      { subject: "MONDO:0004979", predicate: "BFO:0000050", object: "GO:0000001" },
      { subject: "MONDO:0004979", predicate: "BFO:0000051", object: "UBERON:0001004" },
      { subject: "MONDO:0004979", predicate: "RO:0002162", object: "NCBITaxon:9606" },
      { subject: "MONDO:0004979", predicate: "RO:0002202", object: "GO:0000001" },
      { subject: "MONDO:0004979", predicate: "rdf:type", object: "GO:0000001" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM semantic_edge WHERE subject = 'MONDO:0004784' AND predicate = 'RO:0002162'",
    ), [
      { subject: "MONDO:0004784", predicate: "RO:0002162", object: "NCBITaxon:1" },
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
    assert.deepEqual(out, { edgesTable: "semantic_bio_edges", edgeCount: 12, closureTable: "semantic_entailed_edge", closureCount: 3 });
    const ancestors = await conn.all<{ to_id: string }>(
      "SELECT to_id FROM semantic_entailed_edge WHERE from_id = 'MONDO:0004766' ORDER BY to_id",
    );
    assert.deepEqual(ancestors.map((x) => x.to_id), ["MONDO:0004784", "MONDO:0004979"]);

    const metadataProfile: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "semantic-sql-edge-with-metadata",
      title: "SemanticSQL edge metadata projection",
      source: { kind: "semantic_sql", table: "edge_with_metadata" },
      columns: { from: "subject", predicate: "predicate", to: "object", attrs: "attrs", trust: "trust" },
      target: { edgesTable: "semantic_bio_edges_with_metadata" },
    };
    const metadataOut = await materializeGraphProjectionProfile(conn, metadataProfile);
    assert.deepEqual(metadataOut, { edgesTable: "semantic_bio_edges_with_metadata", edgeCount: 12 });
    const [projectedMetadata] = await conn.all<{ attrs: string; trust: string }>(
      "SELECT attrs::VARCHAR AS attrs, trust::VARCHAR AS trust FROM semantic_bio_edges_with_metadata WHERE from_id = 'MONDO:0004979' AND predicate = 'BFO:0000050' AND to_id = 'GO:0000001'",
    );
    assert.ok(projectedMetadata);
    assert.equal(JSON.parse(projectedMetadata!.trust).source_problem_count, 3);

    const superpropertyProfile: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "semantic-sql-edge-by-superproperty",
      title: "SemanticSQL superproperty edge projection",
      source: { kind: "semantic_sql", table: "edge_by_superproperty" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
      target: { edgesTable: "semantic_bio_edges_by_superproperty" },
    };
    const superpropertyOut = await materializeGraphProjectionProfile(conn, superpropertyProfile);
    assert.deepEqual(superpropertyOut, { edgesTable: "semantic_bio_edges_by_superproperty", edgeCount: 2 });
    assert.deepEqual(await conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM semantic_bio_edges_by_superproperty ORDER BY predicate",
    ), [
      { from_id: "MONDO:0004979", predicate: "RO:0000000", to_id: "GO:0000001" },
      { from_id: "MONDO:0004979", predicate: "RO:0000052", to_id: "GO:0000001" },
    ]);

    const associationProfile: GraphProjectionProfile = {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "semantic-sql-term-association",
      title: "SemanticSQL term association projection",
      source: { kind: "semantic_sql", table: "term_association" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
      target: { edgesTable: "association_edges" },
    };
    const associationOut = await materializeGraphProjectionProfile(conn, associationProfile);
    assert.deepEqual(associationOut, { edgesTable: "association_edges", edgeCount: 1 });
    assert.deepEqual(await conn.all<{
      from_id: string;
      predicate: string;
      to_id: string;
      attrs: string | null;
      trust: string | null;
    }>(
      "SELECT from_id, predicate, to_id, attrs, trust FROM association_edges",
    ), [{
      from_id: "case:1",
      predicate: "RO:0002200",
      to_id: "HP:0001250",
      attrs: null,
      trust: null,
    }]);
  });

  test("pins the concrete upstream generated-view contract instead of claiming moving-target parity", () => {
    const sql = semanticSqlSourceViewSql({
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      entailedEdgeTable: "entailed_edge_input",
      termAssociationSourceTable: "term_association_input",
      prefixTable: "prefix_input",
      textualTransformationTable: "textual_transformation_input",
    }).join("\n");
    const generated = new Set([...sql.matchAll(/CREATE OR REPLACE VIEW\s+"([^"]+)"/g)].map((match) => match[1]));
    const missing = SEMANTIC_SQL_UPSTREAM_COMPATIBILITY.concreteViews.filter((view) => !generated.has(view));
    assert.deepEqual(missing, [], `missing concrete views from pinned upstream ${SEMANTIC_SQL_UPSTREAM_COMPATIBILITY.commit}`);
  });

  test("canonicalizes SemanticSQL IRI statements through a prefix table before graph projection", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE TABLE statements(subject TEXT, predicate TEXT, object TEXT, value TEXT, datatype TEXT, language TEXT)");
    await conn.run("CREATE TABLE prefix(prefix TEXT, base TEXT)");
    await conn.run("INSERT INTO prefix VALUES ('OBO','http://purl.obolibrary.org/obo/')");
    await conn.run("INSERT INTO prefix VALUES ('MONDO','http://purl.obolibrary.org/obo/MONDO_')");
    await conn.run("INSERT INTO prefix VALUES ('HP','http://purl.obolibrary.org/obo/HP_')");
    await conn.run("INSERT INTO prefix VALUES ('IAO','http://purl.obolibrary.org/obo/IAO_')");
    await conn.run("INSERT INTO prefix VALUES ('RO','http://purl.obolibrary.org/obo/RO_')");
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
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/HP_0002099','http://www.w3.org/2000/01/rdf-schema#label',NULL,'asthma',NULL,'en')");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004784','http://www.w3.org/2000/01/rdf-schema#subClassOf','http://purl.obolibrary.org/obo/MONDO_0004979',NULL,NULL,NULL)");
    await conn.run("INSERT INTO statements VALUES ('http://purl.obolibrary.org/obo/MONDO_0004766','http://www.w3.org/2000/01/rdf-schema#subClassOf','http://purl.obolibrary.org/obo/MONDO_0004784',NULL,NULL,NULL)");
    await conn.run("CREATE TABLE raw_entailed_edge(subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO raw_entailed_edge VALUES ('http://purl.obolibrary.org/obo/MONDO_0004784','http://www.w3.org/2000/01/rdf-schema#subClassOf','http://purl.obolibrary.org/obo/MONDO_0004979')");
    await conn.run("CREATE TABLE textual_transformation(subject TEXT, predicate TEXT, value TEXT)");
    await conn.run("INSERT INTO textual_transformation VALUES ('asthma','lowercase','asthma')");
    await conn.run("CREATE TABLE raw_term_association(id TEXT, subject TEXT, predicate TEXT, object TEXT, evidence_type TEXT, publication TEXT, source TEXT)");
    await conn.run("INSERT INTO raw_term_association VALUES ('assoc:iri','case:iri','http://purl.obolibrary.org/obo/RO_0002200','http://purl.obolibrary.org/obo/HP_0002099','ECO:0000269','PMID:2','fixture')");

    const views = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      prefixTable: "prefix",
      entailedEdgeTable: "raw_entailed_edge",
      termAssociationSourceTable: "raw_term_association",
      textualTransformationTable: "textual_transformation",
      targets: { edgeTable: "iri_edge", labelsTable: "iri_label", definitionsTable: "iri_definition", synonymsTable: "iri_synonym", termsTable: "iri_terms" },
    });
    assert.equal(views.entailedSubclassOfEdgeTable, "entailed_subclass_of_edge");
    assert.equal(views.subjectPrefixTable, "subject_prefix");
    assert.equal(views.processedStatementTable, "processed_statement");
    assert.equal(views.matchTable, "match");
    assert.equal(views.termAssociationTable, "term_association");

    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM iri_edge ORDER BY subject",
    ), [
      { subject: "MONDO:0004766", predicate: "rdfs:subClassOf", object: "MONDO:0004784" },
      { subject: "MONDO:0004784", predicate: "rdfs:subClassOf", object: "MONDO:0004979" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_label ORDER BY subject"), [
      { subject: "HP:0002099", value: "asthma" },
      { subject: "MONDO:0004979", value: "asthma" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM term_association",
    ), [{ subject: "case:iri", predicate: "RO:0002200", object: "HP:0002099" }]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_definition"), [
      { subject: "MONDO:0004979", value: "A chronic respiratory disorder." },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>("SELECT subject, value FROM iri_synonym"), [
      { subject: "MONDO:0004979", value: "bronchial asthma" },
    ]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; object: string }>(
      "SELECT subject, predicate, object FROM entailed_subclass_of_edge",
    ), [{ subject: "MONDO:0004784", predicate: "rdfs:subClassOf", object: "MONDO:0004979" }]);
    assert.deepEqual(await conn.all<{ anchor_object: string }>(
      "SELECT DISTINCT anchor_object FROM subgraph_edge_by_ancestor WHERE subject = 'MONDO:0004784'",
    ), [{ anchor_object: "MONDO:0004979" }]);
    assert.deepEqual(await conn.all<{ subject: string; value: string }>(
      "SELECT subject, value FROM subject_prefix WHERE subject IN ('HP:0002099', 'MONDO:0004979') ORDER BY subject",
    ), [{ subject: "HP:0002099", value: "HP" }, { subject: "MONDO:0004979", value: "MONDO" }]);
    assert.deepEqual(await conn.all<{ subject: string; predicate: string; transformed_value: string }>(
      "SELECT subject, predicate, transformed_value FROM processed_statement WHERE predicate = 'rdfs:label' ORDER BY subject",
    ), [
      { subject: "HP:0002099", predicate: "rdfs:label", transformed_value: "asthma" },
      { subject: "MONDO:0004979", predicate: "rdfs:label", transformed_value: "asthma" },
    ]);
    assert.deepEqual(await conn.all<{ object_id: string; match_field: string; subject_source: string; object_source: string }>(
      "SELECT object_id, match_field, subject_source, object_source FROM match WHERE subject_id = 'MONDO:0004979'",
    ), [{ object_id: "HP:0002099", match_field: "asthma", subject_source: "MONDO", object_source: "HP" }]);
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

  test("materializes multiple SemanticSQL sources into separate DuckDB schemas for cross-ontology joins", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await conn.run("CREATE SCHEMA mondo");
    await conn.run("CREATE SCHEMA hp");
    await conn.run("CREATE SCHEMA shared");
    await conn.run("CREATE TABLE mondo.statements(subject TEXT, predicate TEXT, object TEXT, value TEXT, datatype TEXT, language TEXT)");
    await conn.run("CREATE TABLE hp.statements(subject TEXT, predicate TEXT, object TEXT, value TEXT, datatype TEXT, language TEXT)");
    await conn.run("INSERT INTO mondo.statements VALUES ('MONDO:0001','rdfs:subClassOf','HP:0001',NULL,NULL,NULL)");
    await conn.run("INSERT INTO hp.statements VALUES ('HP:0001','rdfs:subClassOf','HP:0000',NULL,NULL,NULL)");

    const mondo = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      statementsTable: "mondo.statements",
      targetSchema: "mondo",
      targets: { edgeTable: "shared.mondo_edge" },
    });
    const hp = await materializeSemanticSqlSourceViews(conn, {
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      statementsTable: "hp.statements",
      targetSchema: "hp",
    });

    assert.equal(mondo.edgeTable, "shared.mondo_edge");
    assert.equal(mondo.labelsTable, "mondo.rdfs_label_statement");
    assert.equal(hp.edgeTable, "hp.edge");
    assert.equal(hp.edgeBySuperpropertyTable, "hp.edge_by_superproperty");
    assert.deepEqual(await conn.all<{ disease_id: string; phenotype_parent: string }>(
      `SELECT m.subject AS disease_id, h.object AS phenotype_parent
       FROM shared.mondo_edge m
       JOIN hp.edge h ON h.subject = m.object`,
    ), [{ disease_id: "MONDO:0001", phenotype_parent: "HP:0000" }]);
    assert.deepEqual(
      await materializeGraphProjectionProfile(conn, {
        schema: "pi-bio.graph_projection_profile.v1",
        id: "multi-schema-semantic-sql-edge",
        title: "Multi-schema SemanticSQL edge projection",
        source: { kind: "semantic_sql", table: mondo.edgeTable },
        columns: { from: "subject", predicate: "predicate", to: "object" },
        closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
        target: { edgesTable: "shared.mondo_bio_edges", closureTable: "shared.mondo_entailed_edge" },
      }),
      { edgesTable: "shared.mondo_bio_edges", edgeCount: 1, closureTable: "shared.mondo_entailed_edge", closureCount: 1 },
    );
    assert.deepEqual(await conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM shared.mondo_bio_edges",
    ), [{ from_id: "MONDO:0001", predicate: "rdfs:subClassOf", to_id: "HP:0001" }]);
    assert.deepEqual(await conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM shared.mondo_entailed_edge",
    ), [{ from_id: "MONDO:0001", predicate: "rdfs:subClassOf", to_id: "HP:0001" }]);
  });

  test("SemanticSQL source-spec view generation fails closed on invalid predicate lists", () => {
    assert.throws(
      () => semanticSqlSourceViewSql({ schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA, predicates: { labels: [] } }),
      /at least one non-empty string/,
    );
    assert.doesNotThrow(() => semanticSqlSourceViewSql({
      schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
      termAssociationSourceTable: "term_association",
    }));
    assert.throws(
      () => semanticSqlSourceViewSql({
        schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
        prefixTable: "prefix",
        termAssociationSourceTable: "term_association",
      }),
      /termAssociationSourceTable matches the termAssociationTable target/,
    );
    assert.throws(
      () => semanticSqlSourceViewSql({
        schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
        prefixTable: "prefix",
        termAssociationSourceTable: "main.term_association",
      }),
      /termAssociationSourceTable matches the termAssociationTable target/,
    );
    assert.throws(
      () => semanticSqlSourceViewSql({
        schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
        prefixTable: "prefix",
        termAssociationSourceTable: "\"term_association\"",
      }),
      /termAssociationSourceTable matches the termAssociationTable target/,
    );
    assert.throws(
      () => semanticSqlSourceViewSql({
        schema: SEMANTIC_SQL_SOURCE_SPEC_SCHEMA,
        prefixTable: "mondo.prefix",
        targetSchema: "mondo",
        termAssociationSourceTable: "mondo.term_association",
      }),
      /termAssociationSourceTable matches the termAssociationTable target/,
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
    await conn.run("CREATE SCHEMA artifact");
    await conn.run("CREATE TABLE artifact.edge_raw (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO artifact.edge_raw VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO artifact.edge_raw VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("CREATE TABLE artifact.precomputed_entailed_edge (subject TEXT, predicate TEXT, object TEXT)");
    await conn.run("INSERT INTO artifact.precomputed_entailed_edge VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004784')");
    await conn.run("INSERT INTO artifact.precomputed_entailed_edge VALUES ('MONDO:0004784','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO artifact.precomputed_entailed_edge VALUES ('MONDO:0004766','rdfs:subClassOf','MONDO:0004979')");
    await conn.run("INSERT INTO artifact.precomputed_entailed_edge VALUES ('MONDO:0004766','BFO:0000050','UBERON:0001004')");

    const externalArtifactClosure: GraphProjectionProfile = {
      ...profile,
      id: "external-artifact-closure",
      source: { kind: "external_kg", table: "artifact.edge_raw" },
      target: { edgesTable: "artifact.artifact_closure_edges", closureTable: "artifact.artifact_closure_entailed" },
      closure: {
        source: "upstream_entailed_edge",
        transitivePredicates: ["rdfs:subClassOf"],
        artifactTable: "artifact.precomputed_entailed_edge",
      },
    };

    const out = await materializeGraphProjectionProfile(conn, externalArtifactClosure);
    assert.deepEqual(out, { edgesTable: "artifact.artifact_closure_edges", edgeCount: 2, closureTable: "artifact.artifact_closure_entailed", closureCount: 3 });
    assert.deepEqual(
      await conn.all<{ to_id: string }>(
        "SELECT to_id FROM artifact.artifact_closure_entailed WHERE from_id = 'MONDO:0004766' AND predicate = 'rdfs:subClassOf' ORDER BY to_id",
      ),
      [{ to_id: "MONDO:0004784" }, { to_id: "MONDO:0004979" }],
    );
    assert.deepEqual(await conn.all<{ n: bigint }>("SELECT count(*) AS n FROM artifact.artifact_closure_entailed WHERE predicate = 'BFO:0000050'"), [{ n: 0n }]);
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
