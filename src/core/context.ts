import type { BioArtifact, BioSource, FactBundle, Provenance } from "./types.js";
import type { ResourceRegistry } from "./resources.js";
import type { BioToolRegistry } from "./tool-spec.js";
import type { BioGraphShape } from "./knowledge-graph.js";
import type { OntologyBundle } from "./ontology.js";
import type { DuckDbExtensionCatalog } from "../duckdb/extensions.js";

export interface BioContext {
  schema: "pi-bio.context.v1";
  question?: string;
  selectedSubject?: {
    id: string;
    type: "person" | "sample" | "cohort" | "dataset" | string;
    label?: string;
  };
  assemblies?: string[];
  coordinatePolicy?: {
    defaultSystem: "0-based-half-open" | "1-based-closed";
    requireAssembly: boolean;
  };
  sources: BioSource[];
  artifacts?: BioArtifact[];
  resources?: ResourceRegistry;
  graphShape?: BioGraphShape;
  ontologies?: OntologyBundle[];
  toolRegistry: BioToolRegistry;
  duckdbExtensions?: DuckDbExtensionCatalog;
  facts?: FactBundle;
  provenance?: Provenance[];
}

export function summarizeBioContext(ctx: BioContext): string {
  const lines = [
    `Bio context schema: ${ctx.schema}`,
    ctx.selectedSubject ? `Selected subject: ${ctx.selectedSubject.type}:${ctx.selectedSubject.id}${ctx.selectedSubject.label ? ` (${ctx.selectedSubject.label})` : ""}` : "Selected subject: none",
    `Sources: ${ctx.sources.length}`,
    `Tool specs: ${ctx.toolRegistry.tools.length}`,
    `Resource resolvers: ${ctx.resources?.resolvers.length ?? 0}`,
    `Ontology bundles: ${ctx.ontologies?.length ?? 0}`,
    `DuckDB extensions: ${ctx.duckdbExtensions?.extensions.length ?? 0}`,
  ];
  if (ctx.graphShape) {
    lines.push(`Graph families: ${ctx.graphShape.nodeFamilies.map((f) => `${f.family}${f.count != null ? `=${f.count}` : ""}`).join(", ") || "none"}`);
    lines.push(`Graph predicates: ${ctx.graphShape.edgePredicates.map((e) => `${e.predicate}${e.count != null ? `=${e.count}` : ""}`).join(", ") || "none"}`);
  }
  return lines.join("\n");
}
