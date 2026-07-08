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
  labelsTable?: string;
  definitionsTable?: string;
  synonymsTable?: string;
  mappingsTable?: string;
  deprecatedNodesTable?: string;
  ontologyStatusTable?: string;
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
  labelsTable: string;
  definitionsTable: string;
  synonymsTable: string;
  mappingsTable: string;
  deprecatedNodesTable: string;
  ontologyStatusTable: string;
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

function canonicalIdExpr(column: "subject" | "predicate" | "object", prefixTable: string | undefined): string {
  const quoted = qident(column);
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
    labelsTable: spec.targets?.labelsTable ?? "rdfs_label_statement",
    definitionsTable: spec.targets?.definitionsTable ?? "has_text_definition_statement",
    synonymsTable: spec.targets?.synonymsTable ?? "synonym_statement",
    mappingsTable: spec.targets?.mappingsTable ?? "mapping_statement",
    deprecatedNodesTable: spec.targets?.deprecatedNodesTable ?? "deprecated_node",
    ontologyStatusTable: spec.targets?.ontologyStatusTable ?? "ontology_status_statement",
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
  const subject = canonicalIdExpr("subject", prefixTable);
  const predicate = canonicalIdExpr("predicate", prefixTable);
  const object = canonicalIdExpr("object", prefixTable);
  const value = valueExpr(prefixTable);
  const statementColumns = `SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object, CAST(${qident("value")} AS VARCHAR) AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}`;
  const valueStatementColumns = `SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object, ${value} AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}`;

  return [
    `CREATE OR REPLACE VIEW ${qident(t.edgeTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IS NOT NULL AND object IS NOT NULL
  AND ((${predicate} = 'rdfs:subClassOf' AND ${object} NOT LIKE '_:%') OR ${predicate} = 'rdfs:subPropertyOf')`,

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

    `CREATE OR REPLACE VIEW ${qident(t.labelsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${labelPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.definitionsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${definitionPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.synonymsTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.mappingsTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN (${mappingPredicateSql}) AND object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.deprecatedNodesTable)} AS
SELECT DISTINCT ${subject} AS id
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} = 'owl:deprecated' AND lower(${value}) = 'true'`,

    `CREATE OR REPLACE VIEW ${qident(t.ontologyStatusTable)} AS
${valueStatementColumns}
WHERE subject IS NOT NULL AND ${predicate} IN (${ontologyStatusPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

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
    labelsTable: t.labelsTable,
    definitionsTable: t.definitionsTable,
    synonymsTable: t.synonymsTable,
    mappingsTable: t.mappingsTable,
    deprecatedNodesTable: t.deprecatedNodesTable,
    ontologyStatusTable: t.ontologyStatusTable,
    termsTable: t.termsTable,
  };
}
