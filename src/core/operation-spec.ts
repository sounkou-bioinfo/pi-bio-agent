import type { JsonSchema } from "./json.js";
import type { Provenance } from "./types.js";

// Executable today = duckdb.sql. Non-SQL transports (http/graphql/openapi/mcp/local) were declared but had
// no runner — validated-but-unexecutable surface. They are removed; re-add a transport (and widen this
// union) the day it ships with a runner and a test. The spec stays honest about what can actually run.
export type BioOperationTransport = "duckdb.sql";
export type BioOperationCacheMode = "none" | "metadata" | "materialize";

export interface BioSqlOperationRequest {
  sqlTemplate: string;
  readOnly: true;
  singleStatement?: true;
  /** Resource ids this operation needs resolved into tables. The runner resolves these when the caller
   *  omits an explicit resource list, and asserts an explicit list covers them. */
  requiredResources?: string[];
}

export interface BioOperationIdentifierHint {
  name: string;
  namespace: string;
  required?: boolean;
  description?: string;
}

// Nested inside a manifest's `provides.operations[]` (and the in-memory operation registry, which carries its own
// envelope tag). The manifest/registry schema governs; an operation spec never travels standalone -> no own tag.
export interface BioOperationSpec {
  id: string;
  version: string;
  title: string;
  description: string;
  transport: BioOperationTransport;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  identifiers?: BioOperationIdentifierHint[];
  sql?: BioSqlOperationRequest;
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
  if (typeof spec.id !== "string" || !OPERATION_ID_RE.test(spec.id)) errors.push("id must be lowercase and may use '.', '_' or '-' separators");
  if (typeof spec.version !== "string" || !spec.version.trim()) errors.push("version is required");
  if (typeof spec.title !== "string" || !spec.title.trim()) errors.push("title is required");
  if (typeof spec.description !== "string" || !spec.description.trim()) errors.push("description is required");
  if (!spec.inputSchema || typeof spec.inputSchema !== "object") errors.push("inputSchema is required");
  if (spec.transport !== "duckdb.sql") errors.push("transport must be duckdb.sql");
  if (!spec.sql) errors.push("a duckdb.sql operation requires sql request details");

  if (spec.sql) {
    if (spec.sql.readOnly !== true) errors.push("sql.readOnly must be true");
    if (typeof spec.sql.sqlTemplate !== "string" || !spec.sql.sqlTemplate.trim()) errors.push("sql.sqlTemplate is required"); // typeof guard: a non-string must fail closed, not TypeError on .trim()
  }
  if (spec.cache?.ttlSeconds !== undefined && spec.cache.ttlSeconds < 0) errors.push("cache.ttlSeconds cannot be negative");
  return errors;
}

export function operationSpecIndex(registry: BioOperationRegistry): Array<Pick<BioOperationSpec, "id" | "version" | "title" | "description" | "transport">> {
  return registry.operations.map(({ id, version, title, description, transport }) => ({ id, version, title, description, transport }));
}

export function registryFromOperations(operations: BioOperationSpec[], extras: Omit<BioOperationRegistry, "schema" | "operations"> = {}): BioOperationRegistry {
  return { schema: "pi-bio.operation_registry.v1", operations: operations.map(defineBioOperationSpec), ...extras };
}
