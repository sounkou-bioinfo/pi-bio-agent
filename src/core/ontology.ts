import type { OntologyTermRef } from "./types.js";

// Ontology CURIE primitives. Ontology data tables, predicate vocabularies, and the SQL contract are NOT
// hand-written here: predicates are CURIEs from a registry (RO/BFO/SKOS as data), and table contracts are
// generated from the schema registry — not a `type OntologyEdgePredicate = ... | string` union or a
// hand-maintained `ontologySqlContract()` string for tables nothing creates.

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
