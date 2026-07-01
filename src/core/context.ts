import type { BioSource } from "./types.js";
import type { DuckDbExtensionCatalog } from "../duckdb/extensions.js";

// Compact registry context: what the agent has available, not a speculative aggregate of every bio shape.
// Selected-subject/coordinate-policy/graph-shape/ontology-bundles/facts were removed — they had no
// consumer and pulled the cut domain zoo into core. Re-add a field only when a surface actually uses it.
// In-memory only — the interface IS the contract; no serialized envelope, so no schema tag.
export interface BioContext {
  sources: BioSource[];
  duckdbExtensions?: DuckDbExtensionCatalog;
}

export function summarizeBioContext(ctx: BioContext): string {
  return [
    `Sources: ${ctx.sources.length}`,
    `DuckDB extensions: ${ctx.duckdbExtensions?.extensions.length ?? 0}`,
  ].join("\n");
}
