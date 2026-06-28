import type { BioSource } from "./types.js";
import type { BioToolRegistry } from "./tool-spec.js";
import type { DuckDbExtensionCatalog } from "../duckdb/extensions.js";

// Compact registry context: what the agent has available, not a speculative aggregate of every bio shape.
// Selected-subject/coordinate-policy/graph-shape/ontology-bundles/facts were removed — they had no
// consumer and pulled the cut domain zoo into core. Re-add a field only when a surface actually uses it.
export interface BioContext {
  schema: "pi-bio.context.v1";
  sources: BioSource[];
  toolRegistry: BioToolRegistry;
  duckdbExtensions?: DuckDbExtensionCatalog;
}

export function summarizeBioContext(ctx: BioContext): string {
  return [
    `Bio context schema: ${ctx.schema}`,
    `Sources: ${ctx.sources.length}`,
    `Tool specs: ${ctx.toolRegistry.tools.length}`,
    `DuckDB extensions: ${ctx.duckdbExtensions?.extensions.length ?? 0}`,
  ].join("\n");
}
