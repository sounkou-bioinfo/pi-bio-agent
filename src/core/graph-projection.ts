import type { Provenance } from "./types.js";

export const GRAPH_PROJECTION_PROFILE_SCHEMA = "pi-bio.graph_projection_profile.v1" as const;

const ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
const CURIE_PREFIX_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export interface CuriePrefixBinding {
  prefix: string;
  base: string;
}

export interface GraphProjectionSource {
  /** Open label: foreign_kg, semantic_sql, producer, memory, observations, etc. */
  kind: string;
  /** SQL table/view/relation already materialized in the active DuckDB connection. */
  table: string;
}

export interface GraphProjectionColumns {
  from: string;
  predicate: string;
  to: string;
  attrs?: string;
  trust?: string;
}

export interface GraphProjectionGeneratedViews {
  edge?: "provided" | "semantic_sql" | "none";
  labels?: "provided" | "statements" | "none";
  synonyms?: "provided" | "statements" | "none";
  restrictions?: "provided" | "none";
  axiomAnnotations?: "provided" | "none";
  mappings?: "provided" | "statements" | "none";
  taxonConstraints?: "provided" | "none";
}

export interface GraphProjectionClosurePolicy {
  source: "local_cte" | "relation_graph_artifact" | "upstream_entailed_edge";
  transitivePredicates?: string[];
  artifactTable?: string;
}

export interface GraphProjectionTarget {
  edgesTable?: string;
  closureTable?: string;
  temporal?: { kind: "atemporal" | "as_of"; asOf?: string };
}

export interface GraphProjectionProvenance extends Provenance {
  license?: string;
  deid?: "not_applicable" | "deidentified" | "contains_sensitive" | "unknown";
}

/**
 * A symmetric contract for compiling any source relation into graph shape: imported ontology/KG rows,
 * SemanticSQL views, app producer outputs, memory links, or as-of observation rows. This is deliberately data-only:
 * resolvers and SQL materialize the source, then this profile says how to project it into bio_edges-compatible
 * columns. It is not an ontology runtime and not a connector implementation.
 */
export interface GraphProjectionProfile {
  schema: typeof GRAPH_PROJECTION_PROFILE_SCHEMA;
  id: string;
  title: string;
  description?: string;
  source: GraphProjectionSource;
  columns: GraphProjectionColumns;
  curiePrefixes?: CuriePrefixBinding[];
  generatedViews?: GraphProjectionGeneratedViews;
  closure?: GraphProjectionClosurePolicy;
  target?: GraphProjectionTarget;
  provenance?: GraphProjectionProvenance[];
}

export interface GraphProjectionSqlOptions {
  /** `graphProjectionSql` emits only source->graph projection SQL. Set this only when the caller will separately
   *  execute or account for generated-view, closure, and temporal policies carried by the profile. */
  allowPolicyFields?: boolean;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

function rejectUnknownKeys(obj: unknown, allowed: readonly string[], label: string, errors: string[]): void {
  if (!isObject(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label} has unknown key '${key}' (allowed: ${allowed.join(", ")})`);
  }
}

function nonBlankString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function validateQualifiedIdent(value: unknown, label: string, errors: string[]): void {
  if (!nonBlankString(value) || !QUALIFIED_IDENT_RE.test(value)) errors.push(`${label} must be a SQL identifier or qualified identifier`);
}

function validateIdent(value: unknown, label: string, errors: string[]): void {
  if (!nonBlankString(value) || !IDENT_RE.test(value)) errors.push(`${label} must be a SQL identifier`);
}

function validateStringArray(value: unknown, label: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((x) => !nonBlankString(x))) errors.push(`${label} must be an array of non-empty strings`);
}

export function validateGraphProjectionProfile(profile: GraphProjectionProfile): string[] {
  const errors: string[] = [];
  if (profile?.schema !== GRAPH_PROJECTION_PROFILE_SCHEMA) errors.push(`schema must be ${GRAPH_PROJECTION_PROFILE_SCHEMA}`);
  if (!nonBlankString(profile?.id) || !ID_RE.test(profile.id)) errors.push("profile id is required and must be a stable id");
  if (!nonBlankString(profile?.title)) errors.push("profile title is required");
  if (profile.description !== undefined && typeof profile.description !== "string") errors.push("profile description must be a string");
  rejectUnknownKeys(profile, ["schema", "id", "title", "description", "source", "columns", "curiePrefixes", "generatedViews", "closure", "target", "provenance"], "profile", errors);

  if (!isObject(profile?.source)) errors.push("profile source is required");
  rejectUnknownKeys(profile?.source, ["kind", "table"], "profile.source", errors);
  if (!nonBlankString(profile?.source?.kind)) errors.push("profile.source.kind is required");
  validateQualifiedIdent(profile?.source?.table, "profile.source.table", errors);

  if (!isObject(profile?.columns)) errors.push("profile columns are required");
  rejectUnknownKeys(profile?.columns, ["from", "predicate", "to", "attrs", "trust"], "profile.columns", errors);
  validateIdent(profile?.columns?.from, "profile.columns.from", errors);
  validateIdent(profile?.columns?.predicate, "profile.columns.predicate", errors);
  validateIdent(profile?.columns?.to, "profile.columns.to", errors);
  if (profile?.columns?.attrs !== undefined) validateIdent(profile.columns.attrs, "profile.columns.attrs", errors);
  if (profile?.columns?.trust !== undefined) validateIdent(profile.columns.trust, "profile.columns.trust", errors);

  if (profile.curiePrefixes !== undefined) {
    if (!Array.isArray(profile.curiePrefixes)) errors.push("profile.curiePrefixes must be an array");
    else {
      const seen = new Set<string>();
      for (const [i, binding] of profile.curiePrefixes.entries()) {
        rejectUnknownKeys(binding, ["prefix", "base"], `profile.curiePrefixes[${i}]`, errors);
        if (!nonBlankString(binding?.prefix) || !CURIE_PREFIX_RE.test(binding.prefix)) errors.push(`profile.curiePrefixes[${i}].prefix must be a CURIE prefix`);
        else if (seen.has(binding.prefix)) errors.push(`profile.curiePrefixes prefix '${binding.prefix}' is duplicated`);
        else seen.add(binding.prefix);
        if (!nonBlankString(binding?.base)) errors.push(`profile.curiePrefixes[${i}].base is required`);
      }
    }
  }

  if (profile.generatedViews !== undefined) {
    rejectUnknownKeys(profile.generatedViews, ["edge", "labels", "synonyms", "restrictions", "axiomAnnotations", "mappings", "taxonConstraints"], "profile.generatedViews", errors);
  }

  if (profile.closure !== undefined) {
    rejectUnknownKeys(profile.closure, ["source", "transitivePredicates", "artifactTable"], "profile.closure", errors);
    if (!["local_cte", "relation_graph_artifact", "upstream_entailed_edge"].includes(profile.closure.source)) errors.push("profile.closure.source is invalid");
    validateStringArray(profile.closure.transitivePredicates, "profile.closure.transitivePredicates", errors);
    if (profile.closure.artifactTable !== undefined) validateQualifiedIdent(profile.closure.artifactTable, "profile.closure.artifactTable", errors);
    if (profile.closure.source !== "local_cte" && !profile.closure.artifactTable) errors.push("profile.closure.artifactTable is required when closure.source is not local_cte");
  }

  if (profile.target !== undefined) {
    rejectUnknownKeys(profile.target, ["edgesTable", "closureTable", "temporal"], "profile.target", errors);
    if (profile.target.edgesTable !== undefined) validateQualifiedIdent(profile.target.edgesTable, "profile.target.edgesTable", errors);
    if (profile.target.closureTable !== undefined) validateQualifiedIdent(profile.target.closureTable, "profile.target.closureTable", errors);
    if (profile.target.temporal !== undefined) {
      rejectUnknownKeys(profile.target.temporal, ["kind", "asOf"], "profile.target.temporal", errors);
      if (!["atemporal", "as_of"].includes(profile.target.temporal.kind)) errors.push("profile.target.temporal.kind is invalid");
      if (profile.target.temporal.asOf !== undefined && typeof profile.target.temporal.asOf !== "string") errors.push("profile.target.temporal.asOf must be a string");
    }
  }

  if (profile.provenance !== undefined) {
    if (!Array.isArray(profile.provenance)) errors.push("profile.provenance must be an array");
    else {
      for (const [i, p] of profile.provenance.entries()) {
        rejectUnknownKeys(p, ["source", "version", "command", "sql", "digest", "retrievedAt", "notes", "license", "deid"], `profile.provenance[${i}]`, errors);
        if (!nonBlankString(p?.source)) errors.push(`profile.provenance[${i}].source is required`);
        if (p?.deid !== undefined && !["not_applicable", "deidentified", "contains_sensitive", "unknown"].includes(p.deid)) errors.push(`profile.provenance[${i}].deid is invalid`);
      }
    }
  }
  return errors;
}

export function graphProjectionPolicyWarnings(profile: GraphProjectionProfile): string[] {
  const warnings: string[] = [];
  if (profile.generatedViews !== undefined) {
    warnings.push("generatedViews policy is metadata for the caller/resolver; graphProjectionSql emits only source->graph projection SQL");
  }
  if (profile.closure !== undefined) {
    warnings.push("closure policy must be executed separately with materializeEntailedEdges or a declared upstream closure artifact");
  }
  if (profile.target?.temporal?.kind === "as_of") {
    warnings.push("temporal/as-of policy requires the source relation to already be materialized for that time lens");
  }
  return warnings;
}

function quoteQualifiedIdent(id: string): string {
  return id.split(".").map((part) => `"${part.replace(/"/g, "\"\"")}"`).join(".");
}

export function graphProjectionSql(profile: GraphProjectionProfile, opts: GraphProjectionSqlOptions = {}): string {
  const errors = validateGraphProjectionProfile(profile);
  if (errors.length) throw new Error(`invalid graph projection profile: ${errors.join("; ")}`);
  const warnings = graphProjectionPolicyWarnings(profile);
  if (warnings.length > 0 && !opts.allowPolicyFields) {
    throw new Error(`graphProjectionSql emits only projection SQL; caller must handle profile policy fields separately (${warnings.join("; ")})`);
  }
  const target = profile.target?.edgesTable ?? (profile.target?.temporal?.kind === "as_of" ? "bio_edges_as_of" : "bio_edges");
  const attrs = profile.columns.attrs ? quoteQualifiedIdent(profile.columns.attrs) : "NULL";
  const trust = profile.columns.trust ? quoteQualifiedIdent(profile.columns.trust) : "NULL";
  return `CREATE OR REPLACE TABLE ${quoteQualifiedIdent(target)} AS SELECT ${quoteQualifiedIdent(profile.columns.from)} AS from_id, ${quoteQualifiedIdent(profile.columns.predicate)} AS predicate, ${quoteQualifiedIdent(profile.columns.to)} AS to_id, ${attrs} AS attrs, ${trust} AS trust FROM ${quoteQualifiedIdent(profile.source.table)}`;
}
