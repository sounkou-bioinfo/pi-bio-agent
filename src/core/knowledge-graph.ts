import type { BioArtifact, BioPrimitiveKind, Provenance } from "./types.js";
import type { OntologyTermRef } from "./types.js";

export type BioNodeFamily = "variant" | "interval" | "ontology_term" | "concept" | "artifact" | "memory";

// CURIE/relation id (e.g. "RO:0002211"). Open vocabulary — well-known predicates come from a registry
// (RO/BFO/SKOS as data), not a TS union ending in `| string` (which is not a real enum anyway).
export type BioEdgePredicate = string;

export interface TrustBlock {
  provenanceClass: "evidence" | "attested" | "computed" | "imported" | "inferred";
  confidence?: number;
  producer?: string;
  evidence?: Provenance[];
}

export interface BioGraphNode {
  id: string;
  family: BioNodeFamily;
  type: BioPrimitiveKind | string;
  label: string;
  description?: string;
  attrs?: Record<string, unknown>;
  ontology?: OntologyTermRef[];
  trust?: TrustBlock;
}

export interface BioGraphEdge {
  from: string;
  to: string;
  predicate: BioEdgePredicate;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
}

export interface BioGraphSnapshot {
  schema: "pi-bio.graph_snapshot.v1";
  subject?: string;
  nodes: BioGraphNode[];
  edges: BioGraphEdge[];
  artifacts?: BioArtifact[];
}

const forbiddenSql = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|pragma|install|load|export|import|call|reset|begin|commit|rollback|vacuum|checkpoint)\b/i;

export function validateReadOnlySelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error("query must be a SELECT or WITH ... SELECT");
  if (forbiddenSql.test(trimmed)) throw new Error("query contains forbidden write/DDL keywords");
  return trimmed;
}

// graphSqlContract() was a hand-written list of tables — most of which nothing creates. The real schema is
// what createBioGraphSchema() builds; a generated contract/docs/DDL come from the schema registry. Removed.

export function makeConceptNode(label: string, count?: number): BioGraphNode {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!slug) throw new Error("concept label cannot be empty");
  return {
    id: `concept:${slug}`,
    family: "concept",
    type: "concept",
    label,
    attrs: { slug, count },
  };
}
