import type { JsonSchema, JsonValue } from "./tool-spec.js";
import type { Provenance } from "./types.js";

export type BioOperationTransport = "http" | "graphql" | "openapi" | "duckdb.sql" | "mcp" | "local.code";
export type BioOperationNetworkPolicy = "forbidden" | "explicit-consent" | "allowed";
export type BioOperationCacheMode = "none" | "metadata" | "materialize";

export interface BioHttpOperationRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: JsonValue;
  timeoutSeconds?: number;
  networkPolicy?: BioOperationNetworkPolicy;
}

export interface BioGraphqlOperationRequest {
  endpoint: string;
  query: string;
  operationName?: string;
  variablesSchema?: JsonSchema;
  timeoutSeconds?: number;
  networkPolicy?: BioOperationNetworkPolicy;
}

export interface BioOpenApiOperationRequest {
  specUrl?: string;
  operationId?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate?: string;
  timeoutSeconds?: number;
  networkPolicy?: BioOperationNetworkPolicy;
}

export interface BioSqlOperationRequest {
  sqlTemplate: string;
  readOnly: true;
  singleStatement?: true;
  /** Resource ids this operation needs resolved into tables. The runner resolves these when the caller
   *  omits an explicit resource list, and asserts an explicit list covers them. */
  requiredResources?: string[];
  /** The few columns this operation needs from its resolved inputs — checked by schema discovery before
   *  the query runs. Consumer-local: it is THIS operation's input contract, not a global record type. */
  requiredColumns?: string[];
}

export interface BioMcpOperationRequest {
  server: string;
  tool: string;
}

export interface BioLocalCodeOperationRequest {
  clientName: string;
  functionName: string;
}

export interface BioOperationIdentifierHint {
  name: string;
  namespace: string;
  required?: boolean;
  description?: string;
}

/**
 * Declared, generic report projection over a classification/filter result: each row carries an id and a
 * bucket, and one bucket is the "included" answer; the rest are excluded (each excluded bucket is a reason).
 * The runner derives counts + an auditable report — the analysis is data, not a per-question code module.
 */
export interface BioBucketedReportSpec {
  kind: "bucketed_rows";
  idColumn: string;
  bucketColumn: string;
  includedBucket: string;
  caveats?: string[];
}

export interface BioOperationSpec {
  schema: "pi-bio.operation_spec.v1";
  id: string;
  version: string;
  title: string;
  description: string;
  domains: string[];
  transport: BioOperationTransport;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  identifiers?: BioOperationIdentifierHint[];
  http?: BioHttpOperationRequest;
  graphql?: BioGraphqlOperationRequest;
  openapi?: BioOpenApiOperationRequest;
  sql?: BioSqlOperationRequest;
  mcp?: BioMcpOperationRequest;
  local?: BioLocalCodeOperationRequest;
  report?: BioBucketedReportSpec;
  cache?: {
    mode: BioOperationCacheMode;
    ttlSeconds?: number;
    keyFields?: string[];
  };
  provenance?: {
    includeRequest?: boolean;
    includeResponseDigest?: boolean;
    sources?: Provenance[];
  };
  safety?: {
    networkPolicy?: BioOperationNetworkPolicy;
    acceptsSensitiveData?: boolean;
    sensitiveDataClasses?: string[];
  };
  notes?: string[];
}

export interface BioOperationRegistry {
  schema: "pi-bio.operation_registry.v1";
  operations: BioOperationSpec[];
  provenance?: Provenance[];
}

const OPERATION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function defineBioOperationSpec(spec: BioOperationSpec): BioOperationSpec {
  const errors = validateBioOperationSpec(spec);
  if (errors.length) throw new Error(`invalid BioOperationSpec ${spec.id || "<unnamed>"}: ${errors.join("; ")}`);
  return spec;
}

export function validateBioOperationSpec(spec: BioOperationSpec): string[] {
  const errors: string[] = [];
  const domains = Array.isArray(spec.domains) ? spec.domains : [];
  if (spec.schema !== "pi-bio.operation_spec.v1") errors.push("schema must be pi-bio.operation_spec.v1");
  if (typeof spec.id !== "string" || !OPERATION_ID_RE.test(spec.id)) errors.push("id must be lowercase and may use '.', '_' or '-' separators");
  if (typeof spec.version !== "string" || !spec.version.trim()) errors.push("version is required");
  if (typeof spec.title !== "string" || !spec.title.trim()) errors.push("title is required");
  if (typeof spec.description !== "string" || !spec.description.trim()) errors.push("description is required");
  if (!domains.length) errors.push("at least one domain is required");
  if (!spec.inputSchema || typeof spec.inputSchema !== "object") errors.push("inputSchema is required");
  if (!isTransport(spec.transport)) errors.push("transport is invalid");

  if (spec.transport === "http" && !spec.http) errors.push("http transport requires http request details");
  if (spec.transport === "graphql" && !spec.graphql) errors.push("graphql transport requires graphql request details");
  if (spec.transport === "openapi" && !spec.openapi) errors.push("openapi transport requires openapi request details");
  if (spec.transport === "duckdb.sql" && !spec.sql) errors.push("duckdb.sql transport requires sql request details");
  if (spec.transport === "mcp" && !spec.mcp) errors.push("mcp transport requires mcp request details");
  if (spec.transport === "local.code" && !spec.local) errors.push("local.code transport requires local request details");

  if (spec.http) {
    if (!/^https?:\/\//.test(spec.http.urlTemplate)) errors.push("http.urlTemplate must be absolute http(s)");
    if (spec.http.networkPolicy === "forbidden") errors.push("http operations cannot declare forbidden network policy");
    if (spec.safety?.networkPolicy && spec.http.networkPolicy && spec.safety.networkPolicy !== spec.http.networkPolicy) errors.push("safety.networkPolicy must match http.networkPolicy when both are set");
  }
  if (spec.graphql) {
    if (!/^https?:\/\//.test(spec.graphql.endpoint)) errors.push("graphql.endpoint must be absolute http(s)");
    if (!spec.graphql.query.trim()) errors.push("graphql.query is required");
    if (spec.graphql.networkPolicy === "forbidden") errors.push("graphql operations cannot declare forbidden network policy");
    if (spec.safety?.networkPolicy && spec.graphql.networkPolicy && spec.safety.networkPolicy !== spec.graphql.networkPolicy) errors.push("safety.networkPolicy must match graphql.networkPolicy when both are set");
  }
  if (spec.openapi) {
    if (!spec.openapi.operationId && !(spec.openapi.method && spec.openapi.pathTemplate)) errors.push("openapi requires operationId or method plus pathTemplate");
    if (spec.openapi.specUrl && !/^https?:\/\//.test(spec.openapi.specUrl)) errors.push("openapi.specUrl must be absolute http(s)");
    if (spec.openapi.networkPolicy === "forbidden") errors.push("openapi operations cannot declare forbidden network policy");
    if (spec.safety?.networkPolicy && spec.openapi.networkPolicy && spec.safety.networkPolicy !== spec.openapi.networkPolicy) errors.push("safety.networkPolicy must match openapi.networkPolicy when both are set");
  }
  if (spec.sql) {
    if (spec.sql.readOnly !== true) errors.push("sql.readOnly must be true");
    if (!spec.sql.sqlTemplate.trim()) errors.push("sql.sqlTemplate is required");
    if (spec.sql.requiredColumns && spec.sql.requiredColumns.some((c) => typeof c !== "string" || !c.trim())) {
      errors.push("sql.requiredColumns must be non-empty strings");
    }
  }
  if (spec.report) {
    if (spec.report.kind !== "bucketed_rows") errors.push("report.kind must be 'bucketed_rows'");
    for (const f of ["idColumn", "bucketColumn", "includedBucket"] as const) {
      if (typeof spec.report[f] !== "string" || !spec.report[f].trim()) errors.push(`report.${f} is required`);
    }
  }
  if (spec.cache?.ttlSeconds !== undefined && spec.cache.ttlSeconds < 0) errors.push("cache.ttlSeconds cannot be negative");
  if (spec.safety?.networkPolicy === "forbidden" && (spec.transport === "http" || spec.transport === "graphql" || spec.transport === "openapi")) {
    errors.push("network transports cannot have forbidden safety.networkPolicy");
  }
  return errors;
}

export function operationSpecIndex(registry: BioOperationRegistry): Array<Pick<BioOperationSpec, "id" | "version" | "title" | "description" | "domains" | "transport">> {
  return registry.operations.map(({ id, version, title, description, domains, transport }) => ({ id, version, title, description, domains, transport }));
}

export function registryFromOperations(operations: BioOperationSpec[], extras: Omit<BioOperationRegistry, "schema" | "operations"> = {}): BioOperationRegistry {
  return { schema: "pi-bio.operation_registry.v1", operations: operations.map(defineBioOperationSpec), ...extras };
}

function isTransport(value: unknown): value is BioOperationTransport {
  return value === "http" || value === "graphql" || value === "openapi" || value === "duckdb.sql" || value === "mcp" || value === "local.code";
}
