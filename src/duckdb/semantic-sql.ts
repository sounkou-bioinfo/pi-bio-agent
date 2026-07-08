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
  /** Optional SemanticSQL `prefix(prefix, base)` table. When supplied, generated views canonicalize IRIs to CURIEs. */
  prefixTable?: string;
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
    labelsTable: spec.targets?.labelsTable ?? "rdfs_label_statement",
    synonymsTable: spec.targets?.synonymsTable ?? "synonym_statement",
    mappingsTable: spec.targets?.mappingsTable ?? "mapping_statement",
    termsTable: spec.targets?.termsTable ?? "ontology_terms",
  };
}

export function semanticSqlSourceViewSql(spec: SemanticSqlSourceSpec): string[] {
  if (spec.schema !== SEMANTIC_SQL_SOURCE_SPEC_SCHEMA) throw new Error(`schema must be ${SEMANTIC_SQL_SOURCE_SPEC_SCHEMA}`);
  const statements = qident(spec.statementsTable ?? "statements");
  const prefixTable = spec.prefixTable;
  const t = targets(spec);
  const labels = stringList(spec.predicates?.labels, DEFAULT_LABEL_PREDICATES);
  const synonyms = stringList(spec.predicates?.synonyms, DEFAULT_SYNONYM_PREDICATES);
  const mappings = stringList(spec.predicates?.mappings, DEFAULT_MAPPING_PREDICATES);
  const labelPredicateSql = inList(labels);
  const synonymPredicateSql = inList(synonyms);
  const mappingPredicateSql = inList(mappings);
  const subject = canonicalIdExpr("subject", prefixTable);
  const predicate = canonicalIdExpr("predicate", prefixTable);
  const object = canonicalIdExpr("object", prefixTable);
  const value = valueExpr(prefixTable);

  return [
    `CREATE OR REPLACE VIEW ${qident(t.edgeTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND predicate IS NOT NULL AND object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.labelsTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN (${labelPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.synonymsTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${value} AS value,
       CAST(${qident("datatype")} AS VARCHAR) AS datatype, CAST(${qident("language")} AS VARCHAR) AS language
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.mappingsTable)} AS
SELECT ${subject} AS subject, ${predicate} AS predicate, ${object} AS object
FROM ${statements}
WHERE subject IS NOT NULL AND ${predicate} IN (${mappingPredicateSql}) AND object IS NOT NULL`,

    `CREATE OR REPLACE VIEW ${qident(t.termsTable)} AS
SELECT
  ${subject} AS id,
  min(CASE WHEN ${predicate} IN (${labelPredicateSql}) THEN ${value} ELSE NULL END) AS label,
  list(DISTINCT CASE WHEN ${predicate} IN (${synonymPredicateSql}) THEN ${value} ELSE NULL END)
    FILTER (WHERE ${predicate} IN (${synonymPredicateSql}) AND coalesce(value, object) IS NOT NULL) AS synonyms
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
    labelsTable: t.labelsTable,
    synonymsTable: t.synonymsTable,
    mappingsTable: t.mappingsTable,
    termsTable: t.termsTable,
  };
}
