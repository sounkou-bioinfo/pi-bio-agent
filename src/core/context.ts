import type { BioSource } from "./types.js";

// Compact registry context: what the agent has available, not a speculative aggregate of every bio shape.
// Selected-subject/coordinate-policy/graph-shape/ontology-bundles/facts were removed — they had no
// consumer and pulled the cut domain zoo into core. Re-add a field only when a surface actually uses it.
// In-memory only — the interface IS the contract; no serialized envelope, so no schema tag.
//
// `duckdbExtensions` is typed STRUCTURALLY (only its length is read here), NOT as the duckdb layer's
// DuckDbExtensionCatalog: core declares contracts and must not import UP into ../duckdb (that would leak the
// adapter layer into core's public export surface). A real DuckDbExtensionCatalog still satisfies this shape.
export interface BioContext {
  sources: BioSource[];
  duckdbExtensions?: { extensions: readonly unknown[] };
}

export function summarizeBioContext(ctx: BioContext): string {
  return [
    `Sources: ${ctx.sources.length}`,
    `DuckDB extensions: ${ctx.duckdbExtensions?.extensions.length ?? 0}`,
  ].join("\n");
}
