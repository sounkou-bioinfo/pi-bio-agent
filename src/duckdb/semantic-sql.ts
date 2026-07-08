import type { SqlConn } from "../core/ports.js";

export const SEMANTIC_SQL_SOURCE_SPEC_SCHEMA = "pi-bio.semantic_sql_source_spec.v1" as const;

export interface SemanticSqlSourceViewTargets {
  edgeTable?: string;
  labelsTable?: string;
  synonymsTable?: string;
  mappingsTable?: string;
  termsTable?: string;
}

export interface SemanticSqlSourcePredicates {
  labels?: string[];
  synonyms?: string[];
  mappings?: string[];
}

export interface SemanticSqlSourceSpec {
  schema: typeof SEMANTIC_SQL_SOURCE_SPEC_SCHEMA;
  statementsTable?: string;
  targets?: SemanticSqlSourceViewTargets;
  predicates?: SemanticSqlSourcePredicates;
}

export interface MaterializedSemanticSqlViews {
  edgeTable: string;
  labelsTable: string;
  synonymsTable: string;
  mappingsTable: string;
  termsTable: string;
}

const DEFAULT_LABEL_PREDICATES = ["rdfs:label"];
const DEFAULT_SYNONYM_PREDICATES = [
  "oio:hasExactSynonym",
  "oio:hasRelatedSynonym",
  "oio:hasBroadSynonym",
  "oio:hasNarrowSynonym",
];
const DEFAULT_MAPPING_PREDICATES = [
  "skos:exactMatch",
  "skos:closeMatch",
  "oboInOwl:hasDbXref",
];

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

function valueExpr(): string {
  return "CAST(coalesce(value, object) AS VARCHAR)";
}

function targets(spec: SemanticSqlSourceSpec): Required<SemanticSqlSourceViewTargets> {
  return {
    edgeTable: spec.targets?.edgeTable ?? "edge",
    labelsTable: spec.targets?.labelsTable ?? "rdfs_label_statement",
    synonymsTable: spec.targets?.synonymsTable ?? "synonym_statement",
    mappingsTable: spec.targets?.mappingsTable ?? "mapping_statement",
    termsTable: spec.targets?.termsTable ?? "ontology_terms",
  };
}

export function semanticSqlSourceViewSql(spec: SemanticSqlSourceSpec): string[] {
  if (spec.schema !== SEMANTIC_SQL_SOURCE_SPEC_SCHEMA) throw new Error(`schema must be ${SEMANTIC_SQL_SOURCE_SPEC_SCHEMA}`);
  const statements = qident(spec.statementsTable ?? "statements");
  const t = targets(spec);
  const labels = stringList(spec.predicates?.labels, DEFAULT_LABEL_PREDICATES);
  const synonyms = stringList(spec.predicates?.synonyms, DEFAULT_SYNONYM_PREDICATES);
  const mappings = stringList(spec.predicates?.mappings, DEFAULT_MAPPING_PREDICATES);
  const labelPredicateSql = inList(labels);
  const synonymPredicateSql = inList(synonyms);
  const mappingPredicateSql = inList(mappings);

  return [
    `CREATE OR REPLACE VIEW ${qident(t.edgeTable)} AS
SELECT CAST(subject AS VARCHAR) AS subject, CAST(predicate AS VARCHAR) AS predicate, CAST(object AS VARCHAR) AS object
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IS NOT NULL AND object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.labelsTable)} AS
SELECT CAST(subject AS VARCHAR) AS subject, CAST(predicate AS VARCHAR) AS predicate, ${valueExpr()} AS value,
       CAST(datatype AS VARCHAR) AS datatype, CAST(language AS VARCHAR) AS language
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IN (${labelPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.synonymsTable)} AS
SELECT CAST(subject AS VARCHAR) AS subject, CAST(predicate AS VARCHAR) AS predicate, ${valueExpr()} AS value,
       CAST(datatype AS VARCHAR) AS datatype, CAST(language AS VARCHAR) AS language
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.mappingsTable)} AS
SELECT CAST(subject AS VARCHAR) AS subject, CAST(predicate AS VARCHAR) AS predicate, CAST(object AS VARCHAR) AS object
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IN (${mappingPredicateSql}) AND object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.termsTable)} AS
SELECT
  CAST(subject AS VARCHAR) AS id,
  min(CASE WHEN predicate IN (${labelPredicateSql}) THEN ${valueExpr()} ELSE NULL END) AS label,
  list(DISTINCT CASE WHEN predicate IN (${synonymPredicateSql}) THEN ${valueExpr()} ELSE NULL END)
    FILTER (WHERE predicate IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL) AS synonyms
FROM ${statements}
WHERE subject IS NOT NULL
GROUP BY subject`,
  ];
}

export async function materializeSemanticSqlSourceViews(conn: SqlConn, spec: SemanticSqlSourceSpec): Promise<MaterializedSemanticSqlViews> {
  for (const sql of semanticSqlSourceViewSql(spec)) await conn.run(sql);
  const t = targets(spec);
  return {
    edgeTable: t.edgeTable,
    labelsTable: t.labelsTable,
    synonymsTable: t.synonymsTable,
    mappingsTable: t.mappingsTable,
    termsTable: t.termsTable,
  };
}
