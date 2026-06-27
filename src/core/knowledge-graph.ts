import type { BioArtifact, BioPrimitiveKind, Provenance } from "./types.js";
import type { OntologyTermRef } from "./types.js";

export type BioNodeFamily =
  | "subject"
  | "sample"
  | "observation"
  | "variant"
  | "feature"
  | "interval"
  | "ontology_term"
  | "concept"
  | "artifact"
  | "analysis"
  | "memory";

export type BioEdgePredicate =
  | "has_sample"
  | "has_observation"
  | "has_variant"
  | "overlaps"
  | "contains"
  | "annotated_as"
  | "maps_to"
  | "about"
  | "derived_from"
  | "extracted_from"
  | "supersedes"
  | "supports"
  | "contradicts"
  | string;

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

export interface BioGraphShape {
  schema: "pi-bio.graph_shape.v1";
  nodeFamilies: Array<{ family: BioNodeFamily; count?: number; types?: Array<{ type: string; count?: number }> }>;
  edgePredicates: Array<{ predicate: BioEdgePredicate; count?: number }>;
  jsonKeys?: Record<string, string[]>;
  notes?: string[];
}

export interface BioGraphSnapshot {
  schema: "pi-bio.graph_snapshot.v1";
  subject?: string;
  nodes: BioGraphNode[];
  edges: BioGraphEdge[];
  shape?: BioGraphShape;
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

export function graphSqlContract(): string {
  return [
    "-- Minimal graph-as-SQL contract. Engines may expose richer views, but these names are stable.",
    "bio_nodes(node_id, family, type, label, description, attrs JSON, trust JSON)",
    "bio_edges(from_id, to_id, predicate, attrs JSON, trust JSON)",
    "bio_observations(node_id, subject_id, observed_at, code_system, code_id, name, value, unit, attrs JSON, trust JSON)",
    "bio_artifacts(node_id, path, format, role, digest, attrs JSON)",
    "bio_ontology_terms(system, id, label, definition, synonyms JSON, obsolete BOOLEAN, attrs JSON)",
    "bio_ontology_edges(subject_system, subject_id, predicate, object_system, object_id, attrs JSON)",
  ].join("\n");
}

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
