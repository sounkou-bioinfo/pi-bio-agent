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

export { validateReadOnlySelect } from "./sql-guard.js"; // the single shared read-only SQL guard

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
