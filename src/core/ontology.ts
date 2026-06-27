import type { OntologyTermRef, Provenance } from "./types.js";

export type OntologyEdgePredicate =
  | "is_a"
  | "part_of"
  | "regulates"
  | "negatively_regulates"
  | "positively_regulates"
  | "has_part"
  | "develops_from"
  | "xref"
  | "exact_match"
  | "broad_match"
  | "narrow_match"
  | string;

export interface OntologySource {
  id: string;
  name: string;
  version?: string;
  iri?: string;
  license?: string;
  provenance?: Provenance[];
}

export interface OntologyTermRow extends OntologyTermRef {
  system: string;
  id: string;
  label: string;
  definition?: string;
  synonyms?: string[];
  obsolete?: boolean;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface OntologyEdgeRow {
  subject: OntologyTermRef;
  predicate: OntologyEdgePredicate;
  object: OntologyTermRef;
  source?: string;
  evidence?: Provenance[];
}

export interface OntologyMappingRow {
  from: OntologyTermRef | { system: "local"; id: string; label?: string };
  predicate: "exact_match" | "close_match" | "broad_match" | "narrow_match" | "related_match" | string;
  to: OntologyTermRef;
  confidence?: number;
  source?: Provenance;
}

export interface TermSet {
  id: string;
  label: string;
  description?: string;
  members: OntologyTermRef[];
  expansion?: {
    includeDescendantsOf?: OntologyTermRef[];
    includePredicates?: OntologyEdgePredicate[];
    exclude?: OntologyTermRef[];
  };
  provenance?: Provenance[];
}

export interface OntologyBundle {
  schema: "pi-bio.ontology_bundle.v1";
  sources: OntologySource[];
  terms?: OntologyTermRow[];
  edges?: OntologyEdgeRow[];
  mappings?: OntologyMappingRow[];
  termSets?: TermSet[];
}

export function termKey(term: Pick<OntologyTermRef, "system" | "id">): string {
  return `${term.system}:${term.id}`;
}

export function normalizeTermRef(input: OntologyTermRef | string, defaultSystem?: string): OntologyTermRef {
  if (typeof input !== "string") return input;
  const idx = input.indexOf(":");
  if (idx >= 0) return { kind: "ontology_term", system: input.slice(0, idx), id: input.slice(idx + 1) };
  if (!defaultSystem) throw new Error(`term '${input}' has no system prefix and no default system was supplied`);
  return { kind: "ontology_term", system: defaultSystem, id: input };
}

export function ontologySqlContract(): string {
  return [
    "-- Ontology tables are ordinary SQL graph tables.",
    "ontology_terms(system, id, label, definition, synonyms JSON, obsolete BOOLEAN, source, metadata JSON)",
    "ontology_edges(subject_system, subject_id, predicate, object_system, object_id, source, evidence JSON)",
    "ontology_mappings(from_system, from_id, predicate, to_system, to_id, confidence, source JSON)",
    "term_sets(term_set_id, label, description, provenance JSON)",
    "term_set_members(term_set_id, system, id, include_descendants BOOLEAN, predicates JSON)",
  ].join("\n");
}
