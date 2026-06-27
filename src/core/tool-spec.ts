import type { BioPrimitiveKind, BioSource, Provenance } from "./types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue | undefined };

export type BioToolDeterminism = "deterministic" | "judgment" | "hybrid";

export type BioToolSubstrate =
  | "duckdb.sql"
  | "duckdb.extension"
  | "process"
  | "r"
  | "python"
  | "http"
  | "mcp"
  | "pi"
  | "memory"
  | "study";

export type BioToolEffect = "read" | "write" | "network" | "execute" | "index" | "persist" | "prompt";

export interface BioToolIO {
  name: string;
  kind: BioPrimitiveKind | "question" | "source" | "graph" | "ontology" | "schema" | "tool" | "memory" | "study_note" | "fact_bundle" | "report";
  required?: boolean;
  formats?: string[];
  mediaTypes?: string[];
  description?: string;
}

export interface BioToolParameter {
  name: string;
  schema: JsonSchema;
  required?: boolean;
  description?: string;
  default?: JsonValue;
}

export interface BioToolExecutionSurface {
  substrate: BioToolSubstrate;
  adapter?: string;
  command?: string[];
  sqlTemplate?: string;
  endpoint?: string;
  notes?: string[];
  constraints?: {
    readOnly?: boolean;
    singleStatement?: boolean;
    scopedContext?: boolean;
    requiresConsent?: boolean;
    timeoutSeconds?: number;
  };
}

export interface BioToolSpec {
  schema: "pi-bio.tool_spec.v1";
  name: string;
  version: string;
  title: string;
  description: string;
  domains: string[];
  determinism: BioToolDeterminism;
  inputs: BioToolIO[];
  outputs: BioToolIO[];
  parameters?: BioToolParameter[];
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  surfaces: BioToolExecutionSurface[];
  effects: BioToolEffect[];
  safety?: {
    localFirst?: boolean;
    factsMustBeToolDerived?: boolean;
    sensitiveDataClasses?: string[];
    networkPolicy?: "forbidden" | "explicit-consent" | "allowed";
  };
  provenance?: Provenance[];
  sources?: BioSource[];
  notes?: string[];
}

export interface BioToolRegistry {
  schema: "pi-bio.tool_registry.v1";
  tools: BioToolSpec[];
  sources?: BioSource[];
  provenance?: Provenance[];
}

const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function defineBioToolSpec(spec: BioToolSpec): BioToolSpec {
  const errors = validateBioToolSpec(spec);
  if (errors.length) throw new Error(`invalid BioToolSpec ${spec.name || "<unnamed>"}: ${errors.join("; ")}`);
  return spec;
}

export function validateBioToolSpec(spec: BioToolSpec): string[] {
  const errors: string[] = [];
  const domains = Array.isArray(spec.domains) ? spec.domains : [];
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : undefined;
  const outputs = Array.isArray(spec.outputs) ? spec.outputs : undefined;
  const surfaces = Array.isArray(spec.surfaces) ? spec.surfaces : [];
  const effects = Array.isArray(spec.effects) ? spec.effects : [];
  if (spec.schema !== "pi-bio.tool_spec.v1") errors.push("schema must be pi-bio.tool_spec.v1");
  if (typeof spec.name !== "string" || !TOOL_NAME_RE.test(spec.name)) errors.push("name must be lowercase and may use '.', '_' or '-' separators");
  if (typeof spec.version !== "string" || !spec.version.trim()) errors.push("version is required");
  if (typeof spec.title !== "string" || !spec.title.trim()) errors.push("title is required");
  if (typeof spec.description !== "string" || !spec.description.trim()) errors.push("description is required");
  if (!domains.length) errors.push("at least one domain is required");
  if (!inputs) errors.push("inputs array is required");
  if (!outputs) errors.push("outputs array is required");
  if (!surfaces.length) errors.push("at least one execution surface is required");
  if (!effects.length) errors.push("at least one effect is required");
  if (surfaces.some((surface) => surface.constraints?.readOnly) && effects.includes("write")) errors.push("read-only surfaces cannot declare write effects");
  return errors;
}

export function toolSpecIndex(registry: BioToolRegistry): Array<Pick<BioToolSpec, "name" | "version" | "title" | "description" | "domains" | "determinism" | "effects">> {
  return registry.tools.map(({ name, version, title, description, domains, determinism, effects }) => ({ name, version, title, description, domains, determinism, effects }));
}

export function findToolSpecs(registry: BioToolRegistry, query: string): BioToolSpec[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return registry.tools;
  return registry.tools.filter((tool) => {
    const hay = [tool.name, tool.title, tool.description, ...tool.domains, ...(tool.notes ?? [])].join("\n").toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

export function registryFromTools(tools: BioToolSpec[], extras: Omit<BioToolRegistry, "schema" | "tools"> = {}): BioToolRegistry {
  return { schema: "pi-bio.tool_registry.v1", tools: tools.map(defineBioToolSpec), ...extras };
}
