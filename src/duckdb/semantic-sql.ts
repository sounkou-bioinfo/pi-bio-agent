import type { SqlConn } from "../core/ports.js";

export const SEMANTIC_SQL_SOURCE_SPEC_SCHEMA = "pi-bio.semantic_sql_source_spec.v1" as const;

export interface SemanticSqlSourceViewTargets {
  edgeTable?: string;
  nodeToNodeTable?: string;
  nodeToValueTable?: string;
  rdfTypeTable?: string;
  rdfsSubclassOfTable?: string;
  rdfsSubclassOfNamedTable?: string;
  rdfsSubpropertyOfTable?: string;
  rdfsDomainTable?: string;
  rdfsRangeTable?: string;
  rdfFirstTable?: string;
  rdfRestTable?: string;
  rdfRestTransitiveTable?: string;
  rdfListMemberTable?: string;
  nodeTable?: string;
  nodeIdentifierTable?: string;
  blankNodeTable?: string;
  rdfListNodeTable?: string;
  iriNodeTable?: string;
  classNodeTable?: string;
  propertyNodeTable?: string;
  namedIndividualNodeTable?: string;
  countOfPredicatesTable?: string;
  countOfInstantiatedClassesTable?: string;
  countOfSubclassesTable?: string;
  ontologyNodeTable?: string;
  objectPropertyNodeTable?: string;
  transitivePropertyNodeTable?: string;
  symmetricPropertyNodeTable?: string;
  reflexivePropertyNodeTable?: string;
  irreflexivePropertyNodeTable?: string;
  asymmetricPropertyNodeTable?: string;
  annotationPropertyNodeTable?: string;
  labelsTable?: string;
  definitionsTable?: string;
  exactSynonymsTable?: string;
  broadSynonymsTable?: string;
  narrowSynonymsTable?: string;
  relatedSynonymsTable?: string;
  synonymsTable?: string;
  exactMatchesTable?: string;
  broadMatchesTable?: string;
  narrowMatchesTable?: string;
  relatedMatchesTable?: string;
  matchesTable?: string;
  dbxrefsTable?: string;
  mappingsTable?: string;
  deprecatedNodesTable?: string;
  ontologyStatusTable?: string;
  owlImportsTable?: string;
  owlInverseOfTable?: string;
  owlComplementOfTable?: string;
  owlEquivalentClassTable?: string;
  owlSameAsTable?: string;
  owlDisjointClassTable?: string;
  owlReifiedAxiomTable?: string;
  owlAxiomTable?: string;
  owlAxiomAnnotationTable?: string;
  owlSomeValuesFromTable?: string;
  owlAllValuesFromTable?: string;
  owlHasValueTable?: string;
  owlHasSelfTable?: string;
  owlSubclassOfSomeValuesFromTable?: string;
  owlEquivalentToIntersectionMemberTable?: string;
  contributorTable?: string;
  creatorTable?: string;
  orcidTable?: string;
  axiomDbxrefAnnotationTable?: string;
  trailingWhitespaceProblemTable?: string;
  propertyUsedWithDatatypeValuesAndObjectsTable?: string;
  nodeWithTwoLabelsProblemTable?: string;
  allProblemsTable?: string;
  termsTable?: string;
}

export interface SemanticSqlSourcePredicates {
  labels?: string[];
  definitions?: string[];
  synonyms?: string[];
  mappings?: string[];
}

export interface SemanticSqlSourceSpec {
  schema: typeof SEMANTIC_SQL_SOURCE_SPEC_SCHEMA;
  statementsTable?: string;
  /** Optional source column for SemanticSQL's `statements.stanza`; missing stanza is exposed as NULL. */
  stanzaColumn?: string;
  /** Optional SemanticSQL `prefix(prefix, base)` table. When supplied, generated views canonicalize IRIs to CURIEs. */
  prefixTable?: string;
  targets?: SemanticSqlSourceViewTargets;
  predicates?: SemanticSqlSourcePredicates;
}

export interface MaterializedSemanticSqlViews {
  edgeTable: string;
  nodeToNodeTable: string;
  nodeToValueTable: string;
  rdfTypeTable: string;
  rdfsSubclassOfTable: string;
  rdfsSubclassOfNamedTable: string;
  rdfsSubpropertyOfTable: string;
  rdfsDomainTable: string;
  rdfsRangeTable: string;
  rdfFirstTable: string;
  rdfRestTable: string;
  rdfRestTransitiveTable: string;
  rdfListMemberTable: string;
  nodeTable: string;
  nodeIdentifierTable: string;
  blankNodeTable: string;
  rdfListNodeTable: string;
  iriNodeTable: string;
  classNodeTable: string;
  propertyNodeTable: string;
  namedIndividualNodeTable: string;
  countOfPredicatesTable: string;
  countOfInstantiatedClassesTable: string;
  countOfSubclassesTable: string;
  ontologyNodeTable: string;
  objectPropertyNodeTable: string;
  transitivePropertyNodeTable: string;
  symmetricPropertyNodeTable: string;
  reflexivePropertyNodeTable: string;
  irreflexivePropertyNodeTable: string;
  asymmetricPropertyNodeTable: string;
  annotationPropertyNodeTable: string;
  labelsTable: string;
  definitionsTable: string;
  exactSynonymsTable: string;
  broadSynonymsTable: string;
  narrowSynonymsTable: string;
  relatedSynonymsTable: string;
  synonymsTable: string;
  exactMatchesTable: string;
  broadMatchesTable: string;
  narrowMatchesTable: string;
  relatedMatchesTable: string;
  matchesTable: string;
  dbxrefsTable: string;
  mappingsTable: string;
  deprecatedNodesTable: string;
  ontologyStatusTable: string;
  owlImportsTable: string;
  owlInverseOfTable: string;
  owlComplementOfTable: string;
  owlEquivalentClassTable: string;
  owlSameAsTable: string;
  owlDisjointClassTable: string;
  owlReifiedAxiomTable: string;
  owlAxiomTable: string;
  owlAxiomAnnotationTable: string;
  owlSomeValuesFromTable: string;
  owlAllValuesFromTable: string;
  owlHasValueTable: string;
  owlHasSelfTable: string;
  owlSubclassOfSomeValuesFromTable: string;
  owlEquivalentToIntersectionMemberTable: string;
  contributorTable: string;
  creatorTable: string;
  orcidTable: string;
  axiomDbxrefAnnotationTable: string;
  trailingWhitespaceProblemTable: string;
  propertyUsedWithDatatypeValuesAndObjectsTable: string;
  nodeWithTwoLabelsProblemTable: string;
  allProblemsTable: string;
  termsTable: string;
}

const DEFAULT_LABEL_PREDICATES = ["rdfs:label"];
const DEFAULT_DEFINITION_PREDICATES = ["IAO:0000115"];
const DEFAULT_SYNONYM_PREDICATES = [
  "oio:hasExactSynonym",
  "oio:hasRelatedSynonym",
  "oio:hasBroadSynonym",
  "oio:hasNarrowSynonym",
];
const DEFAULT_MAPPING_PREDICATES = [
  "skos:hasExactMatch",
  "skos:hasBroadMatch",
  "skos:hasNarrowMatch",
  "skos:hasRelatedMatch",
  "skos:exactMatch",
  "skos:closeMatch",
  "oio:hasDbXref",
  "oboInOwl:hasDbXref",
];
const ONTOLOGY_STATUS_PREDICATES = ["<http://obofoundry.github.io/vocabulary/activity_status>", "pav:status"];

function qident(id: string): string {
  const parts = id.split(".");
  if (parts.some((part) => part.length === 0)) throw new Error(`invalid SQL identifier '${id}'`);
  return parts.map((part) => `"${part.replace(/"/g, "\"\"")}"`).join(".");
}

function stringList(value: string[] | undefined, defaults: string[]): string[] {
  if (value === undefined) return defaults;
  if (!Array.isArray(value) || value.length === 0 || value.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    throw new Error("SemanticSQL predicate lists must contain at least one non-empty string");
  }
  return value;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function inList(values: string[]): string {
  return values.map(sqlString).join(", ");
}

function canonicalIdExpr(column: "subject" | "predicate" | "object", prefixTable: string | undefined, tableAlias?: string): string {
  const quoted = tableAlias ? `${qident(tableAlias)}.${qident(column)}` : qident(column);
  const raw = `CAST(${quoted} AS VARCHAR)`;
  if (!prefixTable) return raw;
  const prefixes = qident(prefixTable);
  return [
    `CASE WHEN ${quoted} IS NULL THEN NULL ELSE coalesce((SELECT p.prefix || ':' || substr(${raw}, length(p.base) + 1)`,
    `FROM ${prefixes} p`,
    `WHERE p.prefix IS NOT NULL AND p.base IS NOT NULL AND length(p.prefix) > 0 AND length(p.base) > 0 AND starts_with(${raw}, p.base)`,
    "ORDER BY length(p.base) DESC, p.prefix ASC LIMIT 1),",
    `${raw}) END`,
  ].join(" ");
}

function valueExpr(prefixTable: string | undefined): string {
  const rawValue = `CAST(${qident("value")} AS VARCHAR)`;
  const objectValue = canonicalIdExpr("object", prefixTable);
  return `CAST(coalesce(${rawValue}, ${objectValue}) AS VARCHAR)`;
}

function stanzaExpr(column: string | undefined): string {
  return column ? `CAST(${qident(column)} AS VARCHAR)` : "CAST(NULL AS VARCHAR)";
}

function targets(spec: SemanticSqlSourceSpec): Required<SemanticSqlSourceViewTargets> {
  return {
    edgeTable: spec.targets?.edgeTable ?? "edge",
    nodeToNodeTable: spec.targets?.nodeToNodeTable ?? "node_to_node_statement",
    nodeToValueTable: spec.targets?.nodeToValueTable ?? "node_to_value_statement",
    rdfTypeTable: spec.targets?.rdfTypeTable ?? "rdf_type_statement",
    rdfsSubclassOfTable: spec.targets?.rdfsSubclassOfTable ?? "rdfs_subclass_of_statement",
    rdfsSubclassOfNamedTable: spec.targets?.rdfsSubclassOfNamedTable ?? "rdfs_subclass_of_named_statement",
    rdfsSubpropertyOfTable: spec.targets?.rdfsSubpropertyOfTable ?? "rdfs_subproperty_of_statement",
    rdfsDomainTable: spec.targets?.rdfsDomainTable ?? "rdfs_domain_statement",
    rdfsRangeTable: spec.targets?.rdfsRangeTable ?? "rdfs_range_statement",
    rdfFirstTable: spec.targets?.rdfFirstTable ?? "rdf_first_statement",
    rdfRestTable: spec.targets?.rdfRestTable ?? "rdf_rest_statement",
    rdfRestTransitiveTable: spec.targets?.rdfRestTransitiveTable ?? "rdf_rest_transitive_statement",
    rdfListMemberTable: spec.targets?.rdfListMemberTable ?? "rdf_list_member_statement",
    nodeTable: spec.targets?.nodeTable ?? "node",
    nodeIdentifierTable: spec.targets?.nodeIdentifierTable ?? "node_identifier",
    blankNodeTable: spec.targets?.blankNodeTable ?? "blank_node",
    rdfListNodeTable: spec.targets?.rdfListNodeTable ?? "rdf_list_node",
    iriNodeTable: spec.targets?.iriNodeTable ?? "iri_node",
    classNodeTable: spec.targets?.classNodeTable ?? "class_node",
    propertyNodeTable: spec.targets?.propertyNodeTable ?? "property_node",
    namedIndividualNodeTable: spec.targets?.namedIndividualNodeTable ?? "named_individual_node",
    countOfPredicatesTable: spec.targets?.countOfPredicatesTable ?? "count_of_predicates",
    countOfInstantiatedClassesTable: spec.targets?.countOfInstantiatedClassesTable ?? "count_of_instantiated_classes",
    countOfSubclassesTable: spec.targets?.countOfSubclassesTable ?? "count_of_subclasses",
    ontologyNodeTable: spec.targets?.ontologyNodeTable ?? "ontology_node",
    objectPropertyNodeTable: spec.targets?.objectPropertyNodeTable ?? "object_property_node",
    transitivePropertyNodeTable: spec.targets?.transitivePropertyNodeTable ?? "transitive_property_node",
    symmetricPropertyNodeTable: spec.targets?.symmetricPropertyNodeTable ?? "symmetric_property_node",
    reflexivePropertyNodeTable: spec.targets?.reflexivePropertyNodeTable ?? "reflexive_property_node",
    irreflexivePropertyNodeTable: spec.targets?.irreflexivePropertyNodeTable ?? "irreflexive_property_node",
    asymmetricPropertyNodeTable: spec.targets?.asymmetricPropertyNodeTable ?? "asymmetric_property_node",
    annotationPropertyNodeTable: spec.targets?.annotationPropertyNodeTable ?? "annotation_property_node",
    labelsTable: spec.targets?.labelsTable ?? "rdfs_label_statement",
    definitionsTable: spec.targets?.definitionsTable ?? "has_text_definition_statement",
    exactSynonymsTable: spec.targets?.exactSynonymsTable ?? "has_exact_synonym_statement",
    broadSynonymsTable: spec.targets?.broadSynonymsTable ?? "has_broad_synonym_statement",
    narrowSynonymsTable: spec.targets?.narrowSynonymsTable ?? "has_narrow_synonym_statement",
    relatedSynonymsTable: spec.targets?.relatedSynonymsTable ?? "has_related_synonym_statement",
    synonymsTable: spec.targets?.synonymsTable ?? "synonym_statement",
    exactMatchesTable: spec.targets?.exactMatchesTable ?? "has_exact_match_statement",
    broadMatchesTable: spec.targets?.broadMatchesTable ?? "has_broad_match_statement",
    narrowMatchesTable: spec.targets?.narrowMatchesTable ?? "has_narrow_match_statement",
    relatedMatchesTable: spec.targets?.relatedMatchesTable ?? "has_related_match_statement",
    matchesTable: spec.targets?.matchesTable ?? "has_match_statement",
    dbxrefsTable: spec.targets?.dbxrefsTable ?? "has_dbxref_statement",
    mappingsTable: spec.targets?.mappingsTable ?? "mapping_statement",
    deprecatedNodesTable: spec.targets?.deprecatedNodesTable ?? "deprecated_node",
    ontologyStatusTable: spec.targets?.ontologyStatusTable ?? "ontology_status_statement",
    owlImportsTable: spec.targets?.owlImportsTable ?? "owl_imports_statement",
    owlInverseOfTable: spec.targets?.owlInverseOfTable ?? "owl_inverse_of_statement",
    owlComplementOfTable: spec.targets?.owlComplementOfTable ?? "owl_complement_of_statement",
    owlEquivalentClassTable: spec.targets?.owlEquivalentClassTable ?? "owl_equivalent_class_statement",
    owlSameAsTable: spec.targets?.owlSameAsTable ?? "owl_same_as_statement",
    owlDisjointClassTable: spec.targets?.owlDisjointClassTable ?? "owl_disjoint_class_statement",
    owlReifiedAxiomTable: spec.targets?.owlReifiedAxiomTable ?? "owl_reified_axiom",
    owlAxiomTable: spec.targets?.owlAxiomTable ?? "owl_axiom",
    owlAxiomAnnotationTable: spec.targets?.owlAxiomAnnotationTable ?? "owl_axiom_annotation",
    owlSomeValuesFromTable: spec.targets?.owlSomeValuesFromTable ?? "owl_some_values_from",
    owlAllValuesFromTable: spec.targets?.owlAllValuesFromTable ?? "owl_all_values_from",
    owlHasValueTable: spec.targets?.owlHasValueTable ?? "owl_has_value",
    owlHasSelfTable: spec.targets?.owlHasSelfTable ?? "owl_has_self",
    owlSubclassOfSomeValuesFromTable: spec.targets?.owlSubclassOfSomeValuesFromTable ?? "owl_subclass_of_some_values_from",
    owlEquivalentToIntersectionMemberTable: spec.targets?.owlEquivalentToIntersectionMemberTable ?? "owl_equivalent_to_intersection_member",
    contributorTable: spec.targets?.contributorTable ?? "contributor",
    creatorTable: spec.targets?.creatorTable ?? "creator",
    orcidTable: spec.targets?.orcidTable ?? "orcid",
    axiomDbxrefAnnotationTable: spec.targets?.axiomDbxrefAnnotationTable ?? "axiom_dbxref_annotation",
    trailingWhitespaceProblemTable: spec.targets?.trailingWhitespaceProblemTable ?? "trailing_whitespace_problem",
    propertyUsedWithDatatypeValuesAndObjectsTable: spec.targets?.propertyUsedWithDatatypeValuesAndObjectsTable ?? "property_used_with_datatype_values_and_objects",
    nodeWithTwoLabelsProblemTable: spec.targets?.nodeWithTwoLabelsProblemTable ?? "node_with_two_labels_problem",
    allProblemsTable: spec.targets?.allProblemsTable ?? "all_problems",
    termsTable: spec.targets?.termsTable ?? "ontology_terms",
  };
}

export function semanticSqlSourceViewSql(spec: SemanticSqlSourceSpec): string[] {
  if (spec.schema !== SEMANTIC_SQL_SOURCE_SPEC_SCHEMA) throw new Error(`schema must be ${SEMANTIC_SQL_SOURCE_SPEC_SCHEMA}`);
  const statements = qident(spec.statementsTable ?? "statements");
  const prefixTable = spec.prefixTable;
  const t = targets(spec);
  const labels = stringList(spec.predicates?.labels, DEFAULT_LABEL_PREDICATES);
  const definitions = stringList(spec.predicates?.definitions, DEFAULT_DEFINITION_PREDICATES);
  const synonyms = stringList(spec.predicates?.synonyms, DEFAULT_SYNONYM_PREDICATES);
  const mappings = stringList(spec.predicates?.mappings, DEFAULT_MAPPING_PREDICATES);
  const labelPredicateSql = inList(labels);
  const definitionPredicateSql = inList(definitions);
  const synonymPredicateSql = inList(synonyms);
  const mappingPredicateSql = inList(mappings);
  const ontologyStatusPredicateSql = inList(ONTOLOGY_STATUS_PREDICATES);
  const stanza = stanzaExpr(spec.stanzaColumn);
  const subject = canonicalIdExpr("subject", prefixTable);
  const predicate = canonicalIdExpr("predicate", prefixTable);
  const object = canonicalIdExpr("object", prefixTable);
  const value = valueExpr(prefixTable);
  const statementColumns = `SELECT ${stanza} AS stanza, ${subject} AS subject, ${predicate} AS predicate, ${object} AS object, CAST(${qident("value")} AS VARCHAR) AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}`;
  const valueStatementColumns = `SELECT ${stanza} AS stanza, ${subject} AS subject, ${predicate} AS predicate, ${object} AS object, ${value} AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}`;
  const typedNode = (target: string, rdfTypeObject: string): string => `CREATE OR REPLACE VIEW ${qident(target)} AS
SELECT DISTINCT subject AS id FROM ${qident(t.rdfTypeTable)} WHERE object = ${sqlString(rdfTypeObject)}`;
  const filteredStatement = (target: string, p: string): string => `CREATE OR REPLACE VIEW ${qident(target)} AS
${statementColumns}
WHERE ${predicate} = ${sqlString(p)}`;

  return [
    `CREATE OR REPLACE VIEW ${qident(t.nodeToNodeTable)} AS
${statementColumns}
WHERE object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.nodeToValueTable)} AS
${statementColumns}
WHERE value IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfTypeTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdf:type'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfsSubclassOfTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdfs:subClassOf'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfsSubclassOfNamedTable)} AS
SELECT * FROM ${qident(t.rdfsSubclassOfTable)}
WHERE object NOT LIKE '_:%'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfsSubpropertyOfTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdfs:subPropertyOf'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfsDomainTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdfs:domain'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfsRangeTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdfs:range'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfFirstTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdf:first'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfRestTable)} AS
${statementColumns}
WHERE ${predicate} = 'rdf:rest'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfRestTransitiveTable)} AS
WITH RECURSIVE rest(subject, object) AS (
  SELECT subject, object FROM ${qident(t.rdfRestTable)} WHERE subject IS NOT NULL AND object IS NOT NULL
  UNION
  SELECT r.subject, rt.object
  FROM ${qident(t.rdfRestTable)} r
  JOIN rest rt ON r.object = rt.subject
)
SELECT subject, object FROM rest`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfListMemberTable)} AS
SELECT rt.subject, f.object
FROM ${qident(t.rdfRestTransitiveTable)} rt
JOIN ${qident(t.rdfFirstTable)} f ON rt.object = f.subject
UNION
SELECT subject, object FROM ${qident(t.rdfFirstTable)}`,

    `CREATE OR REPLACE VIEW ${qident(t.nodeTable)} AS
SELECT DISTINCT subject AS id FROM ${qident(t.nodeToNodeTable)} WHERE subject IS NOT NULL
UNION
SELECT DISTINCT object AS id FROM ${qident(t.nodeToNodeTable)} WHERE object IS NOT NULL
UNION
SELECT DISTINCT subject AS id FROM ${qident(t.nodeToValueTable)} WHERE subject IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.nodeIdentifierTable)} AS
SELECT
  id,
  CASE WHEN instr(id, ':') > 0 THEN substr(id, 1, instr(id, ':') - 1) ELSE NULL END AS prefix,
  CASE WHEN instr(id, ':') > 0 THEN substr(id, instr(id, ':') + 1) ELSE id END AS local_identifier
FROM ${qident(t.nodeTable)}`,

    `CREATE OR REPLACE VIEW ${qident(t.blankNodeTable)} AS
SELECT * FROM ${qident(t.nodeTable)} WHERE id LIKE '_:%'`,

    `CREATE OR REPLACE VIEW ${qident(t.rdfListNodeTable)} AS
SELECT DISTINCT subject AS id FROM ${qident(t.rdfTypeTable)} WHERE object = 'rdf:List'`,

    `CREATE OR REPLACE VIEW ${qident(t.iriNodeTable)} AS
SELECT * FROM ${qident(t.nodeTable)} WHERE id NOT LIKE '_:%'`,

    typedNode(t.classNodeTable, "owl:Class"),
    typedNode(t.propertyNodeTable, "owl:Property"),
    typedNode(t.namedIndividualNodeTable, "owl:NamedIndividual"),

    `CREATE OR REPLACE VIEW ${qident(t.countOfPredicatesTable)} AS
SELECT predicate AS element, count(*) AS count_value
FROM (
  SELECT predicate FROM ${qident(t.nodeToNodeTable)}
  UNION ALL
  SELECT predicate FROM ${qident(t.nodeToValueTable)}
)
GROUP BY predicate
ORDER BY count_value DESC`,

    `CREATE OR REPLACE VIEW ${qident(t.countOfInstantiatedClassesTable)} AS
SELECT object AS element, count(*) AS count_value
FROM ${qident(t.rdfTypeTable)}
GROUP BY object
ORDER BY count_value DESC`,

    `CREATE OR REPLACE VIEW ${qident(t.countOfSubclassesTable)} AS
SELECT object AS element, count(DISTINCT subject) AS count_value
FROM ${qident(t.rdfsSubclassOfTable)}
GROUP BY object
ORDER BY count_value DESC`,

    typedNode(t.ontologyNodeTable, "owl:Ontology"),
    typedNode(t.objectPropertyNodeTable, "owl:ObjectProperty"),
    typedNode(t.transitivePropertyNodeTable, "owl:TransitiveProperty"),
    typedNode(t.symmetricPropertyNodeTable, "owl:SymmetricProperty"),
    typedNode(t.reflexivePropertyNodeTable, "owl:ReflexiveProperty"),
    typedNode(t.irreflexivePropertyNodeTable, "owl:IrreflexiveProperty"),
    typedNode(t.asymmetricPropertyNodeTable, "owl:AsymmetricProperty"),
    typedNode(t.annotationPropertyNodeTable, "owl:AnnotationProperty"),

    `CREATE OR REPLACE VIEW ${qident(t.labelsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${labelPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.definitionsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${definitionPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.exactSynonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} = 'oio:hasExactSynonym' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.broadSynonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} = 'oio:hasBroadSynonym' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.narrowSynonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} = 'oio:hasNarrowSynonym' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.relatedSynonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} = 'oio:hasRelatedSynonym' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.synonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.exactMatchesTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN ('skos:hasExactMatch', 'skos:exactMatch') AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.broadMatchesTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} = 'skos:hasBroadMatch' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.narrowMatchesTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} = 'skos:hasNarrowMatch' AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.relatedMatchesTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN ('skos:hasRelatedMatch', 'skos:closeMatch') AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.matchesTable)} AS
SELECT * FROM ${qident(t.exactMatchesTable)}
UNION
SELECT * FROM ${qident(t.broadMatchesTable)}
UNION
SELECT * FROM ${qident(t.narrowMatchesTable)}
UNION
SELECT * FROM ${qident(t.relatedMatchesTable)}`,

    `CREATE OR REPLACE VIEW ${qident(t.dbxrefsTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN ('oio:hasDbXref', 'oboInOwl:hasDbXref') AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.mappingsTable)} AS
SELECT * FROM ${qident(t.matchesTable)}
UNION
SELECT * FROM ${qident(t.dbxrefsTable)}
UNION
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN (${mappingPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.deprecatedNodesTable)} AS
SELECT DISTINCT ${subject} AS id
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} = 'owl:deprecated' AND lower(${value}) = 'true'`,

    `CREATE OR REPLACE VIEW ${qident(t.ontologyStatusTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${ontologyStatusPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    filteredStatement(t.owlImportsTable, "owl:imports"),
    filteredStatement(t.owlInverseOfTable, "owl:inverseOf"),
    filteredStatement(t.owlComplementOfTable, "owl:complementOf"),
    filteredStatement(t.owlEquivalentClassTable, "owl:equivalentClass"),
    filteredStatement(t.owlSameAsTable, "owl:sameAs"),
    filteredStatement(t.owlDisjointClassTable, "owl:disjointWith"),

    `CREATE OR REPLACE VIEW ${qident(t.owlReifiedAxiomTable)} AS
SELECT
  axs.subject AS id,
  axs.stanza AS stanza,
  axs.object AS subject,
  axp.object AS predicate,
  axo.object AS object,
  axo.value AS value,
  axo.datatype AS datatype,
  axo.language AS language
FROM ${qident(t.nodeToNodeTable)} axs
JOIN ${qident(t.nodeToNodeTable)} axp ON axs.subject = axp.subject
JOIN ${qident(t.nodeToNodeTable)} axo ON axs.subject = axo.subject
WHERE axs.predicate = 'owl:annotatedSource'
  AND axp.predicate = 'owl:annotatedProperty'
  AND axo.predicate = 'owl:annotatedTarget'`,

    `CREATE OR REPLACE VIEW ${qident(t.owlAxiomTable)} AS
SELECT id, stanza, subject, predicate, object, value, datatype, language FROM ${qident(t.owlReifiedAxiomTable)}
UNION
SELECT CAST(NULL AS VARCHAR) AS id, stanza, subject, predicate, object, value, datatype, language
FROM ${qident(t.nodeToNodeTable)}
UNION
SELECT CAST(NULL AS VARCHAR) AS id, stanza, subject, predicate, object, value, datatype, language
FROM ${qident(t.nodeToValueTable)}`,

    `CREATE OR REPLACE VIEW ${qident(t.owlAxiomAnnotationTable)} AS
SELECT
  axpv.stanza AS stanza,
  axs.object AS subject,
  axp.object AS predicate,
  axo.object AS object,
  axo.value AS value,
  axo.datatype AS datatype,
  axo.language AS language,
  axpv.subject AS id,
  axpv.subject AS annotation_subject,
  axpv.predicate AS annotation_predicate,
  axpv.object AS annotation_object,
  axpv.value AS annotation_value,
  axpv.language AS annotation_language,
  axpv.datatype AS annotation_datatype
FROM ${qident(t.nodeToNodeTable)} axs
JOIN ${qident(t.nodeToNodeTable)} axp ON axs.subject = axp.subject
JOIN ${qident(t.nodeToNodeTable)} axo ON axs.subject = axo.subject
JOIN (
  SELECT * FROM ${qident(t.nodeToNodeTable)}
  UNION
  SELECT * FROM ${qident(t.nodeToValueTable)}
) axpv ON axs.subject = axpv.subject
WHERE axs.predicate = 'owl:annotatedSource'
  AND axp.predicate = 'owl:annotatedProperty'
  AND axo.predicate = 'owl:annotatedTarget'
  AND axpv.predicate NOT IN ('owl:annotatedSource', 'owl:annotatedProperty', 'owl:annotatedTarget', 'rdf:type')`,

    `CREATE OR REPLACE VIEW ${qident(t.owlSomeValuesFromTable)} AS
SELECT on_property.subject AS id, on_property.object AS on_property, filler.object AS filler
FROM ${qident(t.nodeToNodeTable)} on_property
JOIN ${qident(t.nodeToNodeTable)} filler ON on_property.subject = filler.subject
WHERE on_property.predicate = 'owl:onProperty' AND filler.predicate = 'owl:someValuesFrom'`,

    `CREATE OR REPLACE VIEW ${qident(t.owlAllValuesFromTable)} AS
SELECT on_property.subject AS id, on_property.object AS on_property, filler.object AS filler
FROM ${qident(t.nodeToNodeTable)} on_property
JOIN ${qident(t.nodeToNodeTable)} filler ON on_property.subject = filler.subject
WHERE on_property.predicate = 'owl:onProperty' AND filler.predicate = 'owl:allValuesFrom'`,

    `CREATE OR REPLACE VIEW ${qident(t.owlHasValueTable)} AS
SELECT on_property.subject AS id, on_property.object AS on_property, filler.object AS filler
FROM ${qident(t.nodeToNodeTable)} on_property
JOIN ${qident(t.nodeToNodeTable)} filler ON on_property.subject = filler.subject
WHERE on_property.predicate = 'owl:onProperty' AND filler.predicate = 'owl:hasValue'`,

    `CREATE OR REPLACE VIEW ${qident(t.owlHasSelfTable)} AS
SELECT on_property.subject AS id, on_property.object AS on_property, self.value AS filler
FROM ${qident(t.nodeToNodeTable)} on_property
JOIN ${qident(t.nodeToValueTable)} self ON on_property.subject = self.subject
WHERE on_property.predicate = 'owl:onProperty' AND self.predicate = 'owl:hasSelf' AND lower(self.value) = 'true'`,

    `CREATE OR REPLACE VIEW ${qident(t.owlSubclassOfSomeValuesFromTable)} AS
SELECT subclass.stanza, subclass.subject, restriction.on_property AS predicate, restriction.filler AS object
FROM ${qident(t.rdfsSubclassOfTable)} subclass
JOIN ${qident(t.owlSomeValuesFromTable)} restriction ON restriction.id = subclass.object`,

    `CREATE OR REPLACE VIEW ${qident(t.owlEquivalentToIntersectionMemberTable)} AS
SELECT equivalent.stanza, equivalent.subject, member.object
FROM ${qident(t.owlEquivalentClassTable)} equivalent
JOIN ${qident(t.nodeToNodeTable)} intersection ON equivalent.object = intersection.subject
JOIN ${qident(t.rdfListMemberTable)} member ON intersection.object = member.subject
WHERE intersection.predicate = 'owl:intersectionOf'`,

    `CREATE OR REPLACE VIEW ${qident(t.contributorTable)} AS
${statementColumns}
WHERE ${predicate} = 'dcterms:contributor'`,

    `CREATE OR REPLACE VIEW ${qident(t.creatorTable)} AS
${statementColumns}
WHERE ${predicate} = 'dcterms:creator'`,

    `CREATE OR REPLACE VIEW ${qident(t.orcidTable)} AS
SELECT subject AS id, value AS label
FROM ${qident(t.labelsTable)}
WHERE subject LIKE 'orcid:%'`,

    `CREATE OR REPLACE VIEW ${qident(t.axiomDbxrefAnnotationTable)} AS
SELECT * FROM ${qident(t.owlAxiomAnnotationTable)}
WHERE annotation_predicate IN ('oio:hasDbXref', 'oboInOwl:hasDbXref')`,

    `CREATE OR REPLACE VIEW ${qident(t.trailingWhitespaceProblemTable)} AS
SELECT subject, predicate, value
FROM ${qident(t.nodeToValueTable)}
WHERE value LIKE ' %' OR value LIKE '% '`,

    `CREATE OR REPLACE VIEW ${qident(t.propertyUsedWithDatatypeValuesAndObjectsTable)} AS
SELECT DISTINCT v.predicate AS subject, v.predicate AS predicate, v.datatype AS value
FROM ${qident(t.nodeToValueTable)} v
JOIN ${qident(t.nodeToNodeTable)} o ON v.predicate = o.predicate`,

    `CREATE OR REPLACE VIEW ${qident(t.nodeWithTwoLabelsProblemTable)} AS
SELECT labels1.subject, labels1.predicate, labels1.value
FROM ${qident(t.labelsTable)} labels1
JOIN ${qident(t.labelsTable)} labels2 ON labels1.subject = labels2.subject
WHERE labels1.value != labels2.value`,

    `CREATE OR REPLACE VIEW ${qident(t.allProblemsTable)} AS
SELECT subject, predicate, value FROM ${qident(t.nodeWithTwoLabelsProblemTable)}
UNION
SELECT subject, predicate, value FROM ${qident(t.trailingWhitespaceProblemTable)}`,

    `CREATE OR REPLACE VIEW ${qident(t.edgeTable)} AS
SELECT subject, predicate, object
FROM ${qident(t.owlSubclassOfSomeValuesFromTable)}
UNION
SELECT subject, predicate, object
FROM ${qident(t.rdfsSubclassOfNamedTable)}
UNION
SELECT subject, predicate, object
FROM ${qident(t.rdfsSubpropertyOfTable)}
UNION
SELECT subject, predicate, object
FROM ${qident(t.rdfTypeTable)}
WHERE object IN (SELECT id FROM ${qident(t.classNodeTable)})`,

    `CREATE OR REPLACE VIEW ${qident(t.termsTable)} AS
SELECT
  ${subject} AS id,
  min(CASE WHEN ${predicate} IN (${labelPredicateSql}) THEN ${value} ELSE NULL END) AS label,
  min(CASE WHEN ${predicate} IN (${definitionPredicateSql}) THEN ${value} ELSE NULL END) AS definition,
  list(DISTINCT CASE WHEN ${predicate} IN (${synonymPredicateSql}) THEN ${value} ELSE NULL END)
    FILTER (WHERE ${predicate} IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL) AS synonyms,
  max(CASE WHEN ${predicate} = 'owl:deprecated' AND lower(${value}) = 'true' THEN 1 ELSE 0 END) > 0 AS deprecated
FROM ${statements}
WHERE subject IS NOT NULL
GROUP BY ${subject}`,
  ];
}

export async function materializeSemanticSqlSourceViews(conn: SqlConn, spec: SemanticSqlSourceSpec): Promise<MaterializedSemanticSqlViews> {
  for (const sql of semanticSqlSourceViewSql(spec)) await conn.run(sql);
  const t = targets(spec);
  return {
    edgeTable: t.edgeTable,
    nodeToNodeTable: t.nodeToNodeTable,
    nodeToValueTable: t.nodeToValueTable,
    rdfTypeTable: t.rdfTypeTable,
    rdfsSubclassOfTable: t.rdfsSubclassOfTable,
    rdfsSubclassOfNamedTable: t.rdfsSubclassOfNamedTable,
    rdfsSubpropertyOfTable: t.rdfsSubpropertyOfTable,
    rdfsDomainTable: t.rdfsDomainTable,
    rdfsRangeTable: t.rdfsRangeTable,
    rdfFirstTable: t.rdfFirstTable,
    rdfRestTable: t.rdfRestTable,
    rdfRestTransitiveTable: t.rdfRestTransitiveTable,
    rdfListMemberTable: t.rdfListMemberTable,
    nodeTable: t.nodeTable,
    nodeIdentifierTable: t.nodeIdentifierTable,
    blankNodeTable: t.blankNodeTable,
    rdfListNodeTable: t.rdfListNodeTable,
    iriNodeTable: t.iriNodeTable,
    classNodeTable: t.classNodeTable,
    propertyNodeTable: t.propertyNodeTable,
    namedIndividualNodeTable: t.namedIndividualNodeTable,
    countOfPredicatesTable: t.countOfPredicatesTable,
    countOfInstantiatedClassesTable: t.countOfInstantiatedClassesTable,
    countOfSubclassesTable: t.countOfSubclassesTable,
    ontologyNodeTable: t.ontologyNodeTable,
    objectPropertyNodeTable: t.objectPropertyNodeTable,
    transitivePropertyNodeTable: t.transitivePropertyNodeTable,
    symmetricPropertyNodeTable: t.symmetricPropertyNodeTable,
    reflexivePropertyNodeTable: t.reflexivePropertyNodeTable,
    irreflexivePropertyNodeTable: t.irreflexivePropertyNodeTable,
    asymmetricPropertyNodeTable: t.asymmetricPropertyNodeTable,
    annotationPropertyNodeTable: t.annotationPropertyNodeTable,
    labelsTable: t.labelsTable,
    definitionsTable: t.definitionsTable,
    exactSynonymsTable: t.exactSynonymsTable,
    broadSynonymsTable: t.broadSynonymsTable,
    narrowSynonymsTable: t.narrowSynonymsTable,
    relatedSynonymsTable: t.relatedSynonymsTable,
    synonymsTable: t.synonymsTable,
    exactMatchesTable: t.exactMatchesTable,
    broadMatchesTable: t.broadMatchesTable,
    narrowMatchesTable: t.narrowMatchesTable,
    relatedMatchesTable: t.relatedMatchesTable,
    matchesTable: t.matchesTable,
    dbxrefsTable: t.dbxrefsTable,
    mappingsTable: t.mappingsTable,
    deprecatedNodesTable: t.deprecatedNodesTable,
    ontologyStatusTable: t.ontologyStatusTable,
    owlImportsTable: t.owlImportsTable,
    owlInverseOfTable: t.owlInverseOfTable,
    owlComplementOfTable: t.owlComplementOfTable,
    owlEquivalentClassTable: t.owlEquivalentClassTable,
    owlSameAsTable: t.owlSameAsTable,
    owlDisjointClassTable: t.owlDisjointClassTable,
    owlReifiedAxiomTable: t.owlReifiedAxiomTable,
    owlAxiomTable: t.owlAxiomTable,
    owlAxiomAnnotationTable: t.owlAxiomAnnotationTable,
    owlSomeValuesFromTable: t.owlSomeValuesFromTable,
    owlAllValuesFromTable: t.owlAllValuesFromTable,
    owlHasValueTable: t.owlHasValueTable,
    owlHasSelfTable: t.owlHasSelfTable,
    owlSubclassOfSomeValuesFromTable: t.owlSubclassOfSomeValuesFromTable,
    owlEquivalentToIntersectionMemberTable: t.owlEquivalentToIntersectionMemberTable,
    contributorTable: t.contributorTable,
    creatorTable: t.creatorTable,
    orcidTable: t.orcidTable,
    axiomDbxrefAnnotationTable: t.axiomDbxrefAnnotationTable,
    trailingWhitespaceProblemTable: t.trailingWhitespaceProblemTable,
    propertyUsedWithDatatypeValuesAndObjectsTable: t.propertyUsedWithDatatypeValuesAndObjectsTable,
    nodeWithTwoLabelsProblemTable: t.nodeWithTwoLabelsProblemTable,
    allProblemsTable: t.allProblemsTable,
    termsTable: t.termsTable,
  };
}
