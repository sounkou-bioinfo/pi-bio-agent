import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  describeBioManifestFromPath,
  listManifestCatalog,
  reproduceRun,
  runBioOperationFromManifest,
  runBioQueryFromManifest,
  runsRoot,
  type CasStore,
  type ComputeRunner,
  type DucknngHttpProfileSpec,
  type FetchLike,
  type HostCapabilityReceipt,
  type HostResolverBindings,
  type RunOperationResponse,
  type RunReplaySpec,
  type SqlConn,
  type SqlConnPolicy,
} from "pi-bio-agent";
import {
  createMcpHandler,
  McpServer,
  ResourceTemplate,
  type McpHttpHandler,
  type McpRequestContext,
  type PerRequestResponseMode,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const BIO_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const BIO_MCP_RESULT_SCHEMA = "pi-bio.mcp_result.v1" as const;

export type BioMcpPermissionProfile = "exploratory" | "operations-only" | "sealed-offline";
export type BioMcpLegacyPosture = "reject" | "stateless";
export type BioMcpResultDelivery = "inline" | "reference";

export interface BioMcpHostOptions {
  /** Host workspace. The manifest catalog must resolve beneath this directory. */
  cwd: string;
  /** Host-selected catalog root, relative to cwd or absolute. It must resolve beneath cwd. */
  catalogRoot: string;
  /** Scientific database selected by the host; defaults to a fresh in-memory database per call. */
  dbPath?: string;
  /** Model-visible capability profile. The host still owns OS, filesystem, extension and egress isolation. */
  profile?: BioMcpPermissionProfile;
  /** Verified actor identity. When omitted, verified MCP authInfo.clientId is used, then mcp:anonymous. */
  author?: string;
  cas?: CasStore;
  store?: SqlConn;
  casMetadata?: { conn: SqlConn; nowMs?: number };
  network?: { fetch: FetchLike };
  compute?: { runner: ComputeRunner };
  resolverBindings?: HostResolverBindings;
  remoteCacheScope?: string;
  duckdbInitSql?: string[];
  protectedSessionBindings?: Record<string, unknown>;
  protectedSessionVariables?: string[];
  duckdbConfig?: Record<string, string>;
  sqlPolicy?: SqlConnPolicy;
  hostCapabilityReceipts?: readonly HostCapabilityReceipt[];
  ducknngHttpProfiles?: readonly DucknngHttpProfileSpec[];
  /** Modern-only by default. `stateless` deliberately enables the SDK's per-request 2025 fallback. */
  legacy?: BioMcpLegacyPosture;
  responseMode?: PerRequestResponseMode;
  onerror?: (error: Error) => void;
}

interface PreparedBioMcpHost extends BioMcpHostOptions {
  cwd: string;
  catalogRoot: string;
  dbPath: string;
  profile: BioMcpPermissionProfile;
}

interface BioMcpEnvelope {
  schema: typeof BIO_MCP_RESULT_SCHEMA;
  kind: string;
  data: JsonValue;
}

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

type RunPart = "run" | "result" | "receipts" | "replay" | "cas-refs";

const RUN_PARTS = ["run", "result", "receipts", "replay", "cas-refs"] as const satisfies readonly RunPart[];
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MCP_OUTPUT_SCHEMA = z.object({
  schema: z.literal(BIO_MCP_RESULT_SCHEMA),
  kind: z.string(),
  data: z.unknown(),
});
const BINDINGS_SCHEMA = z.record(z.string(), z.unknown());
const RESULT_DELIVERY_SCHEMA = z.enum(["inline", "reference"]);
const RUN_PART_SCHEMA = z.enum(RUN_PARTS);

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonValue(value: unknown, seen: Set<object> = new Set()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "undefined") return null;
  if (value instanceof Uint8Array) return { type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("MCP result contains a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, seen));
    if (!isPlainObject(value)) return String(value);
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) output[key] = jsonValue(entry, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function mcpResult(kind: string, data: unknown) {
  const structuredContent: BioMcpEnvelope = {
    schema: BIO_MCP_RESULT_SCHEMA,
    kind,
    data: jsonValue(data),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function isContained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertContained(root: string, path: string, label: string): void {
  if (!isContained(root, path)) throw new Error(`${label} resolves outside the host-approved root`);
}

async function prepareHost(options: BioMcpHostOptions): Promise<PreparedBioMcpHost> {
  const cwd = await fs.realpath(resolve(options.cwd));
  const catalogRoot = await fs.realpath(resolve(cwd, options.catalogRoot));
  assertContained(cwd, catalogRoot, "catalogRoot");
  const profile = options.profile ?? "exploratory";
  if (profile === "sealed-offline") {
    if (!options.cas) throw new Error("sealed-offline MCP profile requires a CAS so successful results are content-pinned");
    if (options.network || options.compute || options.ducknngHttpProfiles?.length || Object.keys(options.resolverBindings ?? {}).length) {
      throw new Error("sealed-offline MCP profile refuses network, compute, DuckNNG profiles and injected resolver implementations");
    }
  }
  if (options.casMetadata && !options.store) throw new Error("MCP casMetadata requires the same host-owned store authority");
  if (options.casMetadata && options.store && options.casMetadata.conn !== options.store) {
    throw new Error("MCP casMetadata.conn must be the same SqlConn supplied as store");
  }
  return {
    ...options,
    cwd,
    catalogRoot,
    dbPath: options.dbPath ?? ":memory:",
    profile,
  };
}

function catalogRootArgument(host: PreparedBioMcpHost): string {
  const rel = relative(host.cwd, host.catalogRoot);
  return rel === "" ? "." : rel;
}

async function hostCatalog(host: PreparedBioMcpHost, query?: string, includeInvalid = false) {
  return listManifestCatalog({
    cwd: host.cwd,
    root: catalogRootArgument(host),
    query,
    includeInvalid,
  });
}

async function resolveManifest(host: PreparedBioMcpHost, manifestId: string) {
  const catalog = await hostCatalog(host);
  const matches = catalog.entries.filter((entry) => entry.id === manifestId);
  if (matches.length === 0) throw new Error(`manifest id '${manifestId}' is not present in the host-approved catalog`);
  if (matches.length > 1) throw new Error(`manifest id '${manifestId}' is ambiguous in the host-approved catalog`);
  const entry = matches[0]!;
  const path = await fs.realpath(resolve(host.cwd, entry.manifestPath));
  assertContained(host.catalogRoot, path, `manifest '${manifestId}'`);
  return {
    entry,
    path,
    manifestPath: relative(host.cwd, path),
  };
}

function manifestUri(manifestId: string): string {
  return `pi-bio://manifests/${encodeURIComponent(manifestId)}`;
}

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) throw new Error("runId must use the public pi-bio run-id grammar");
}

function runPartFile(part: RunPart): string {
  return part === "cas-refs" ? "cas-refs.json" : `${part}.json`;
}

function runPartUri(runId: string, part: RunPart): string {
  assertRunId(runId);
  return `pi-bio://runs/${encodeURIComponent(runId)}/${part}`;
}

async function readRunPart(host: PreparedBioMcpHost, runId: string, part: RunPart): Promise<{ text: string; value: unknown }> {
  assertRunId(runId);
  const root = await fs.realpath(runsRoot(host.cwd));
  const path = await fs.realpath(join(root, runId, runPartFile(part)));
  assertContained(root, path, `run '${runId}' evidence`);
  const text = await fs.readFile(path, "utf8");
  return { text, value: JSON.parse(text) as unknown };
}

function isNotFound(error: unknown): boolean {
  return !!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

function runEvidenceUris(runId: string, succeeded: boolean): Record<string, string> {
  return {
    run: runPartUri(runId, "run"),
    receipts: runPartUri(runId, "receipts"),
    replay: runPartUri(runId, "replay"),
    ...(succeeded ? { result: runPartUri(runId, "result") } : {}),
    "cas-refs": runPartUri(runId, "cas-refs"),
  };
}

function projectRunResponse(response: RunOperationResponse, delivery: BioMcpResultDelivery) {
  const base = {
    ok: response.ok,
    runId: response.runId,
    operationId: response.operationId,
    status: response.status,
    casRefs: response.casRefs,
    evidence: runEvidenceUris(response.runId, response.ok),
  };
  if (!response.ok) return { ...base, error: response.error };
  return {
    ...base,
    rowCount: response.rowCount,
    delivery,
    result: delivery === "inline"
      ? response.result
      : {
          schema: response.result.schema,
          operationId: response.result.operationId,
          runId: response.result.runId,
          rowCount: response.rowCount,
          uri: runPartUri(response.runId, "result"),
        },
  };
}

function requestAuthor(host: PreparedBioMcpHost, requestContext?: McpRequestContext): string {
  if (host.author) return host.author;
  const clientId = requestContext?.authInfo?.clientId;
  return clientId ? `mcp:${clientId}` : "mcp:anonymous";
}

function externalCapabilities(host: PreparedBioMcpHost) {
  if (host.profile === "sealed-offline") return {};
  return {
    network: host.network,
    compute: host.compute,
    resolverBindings: host.resolverBindings,
    ducknngHttpProfiles: host.ducknngHttpProfiles,
  };
}

function commonRunOptions(host: PreparedBioMcpHost, requestContext: McpRequestContext | undefined, signal: AbortSignal) {
  return {
    cwd: host.cwd,
    dbPath: host.dbPath,
    signal,
    cas: host.cas,
    store: host.store,
    author: requestAuthor(host, requestContext),
    casMetadata: host.casMetadata,
    remoteCacheScope: host.remoteCacheScope,
    duckdbInitSql: host.duckdbInitSql,
    protectedSessionBindings: host.protectedSessionBindings,
    protectedSessionVariables: host.protectedSessionVariables,
    duckdbConfig: host.duckdbConfig,
    sqlPolicy: host.sqlPolicy,
    hostCapabilityReceipts: host.hostCapabilityReceipts,
    serialize: true,
    ...externalCapabilities(host),
  };
}

function commonReplayOptions(host: PreparedBioMcpHost, requestContext: McpRequestContext | undefined, signal: AbortSignal) {
  const external = externalCapabilities(host);
  return {
    cwd: host.cwd,
    dbPath: ":memory:",
    signal,
    cas: host.cas,
    store: host.store,
    author: requestAuthor(host, requestContext),
    remoteCacheScope: host.remoteCacheScope,
    duckdbInitSql: host.duckdbInitSql,
    protectedSessionBindings: host.protectedSessionBindings,
    protectedSessionVariables: host.protectedSessionVariables,
    duckdbConfig: host.duckdbConfig,
    hostCapabilityReceipts: host.hostCapabilityReceipts,
    network: external.network,
    compute: external.compute,
    resolverBindings: external.resolverBindings,
  };
}

function transformedCatalog(catalog: Awaited<ReturnType<typeof hostCatalog>>) {
  const { schema, root, query, entries, invalid } = catalog;
  return {
    schema,
    root,
    ...(query ? { query } : {}),
    entries: entries.map(({ manifestPath: _manifestPath, ...entry }) => ({
      ...entry,
      resourceUri: manifestUri(entry.id),
    })),
    invalid: invalid.map(({ manifestPath: _manifestPath, ...entry }) => entry),
  };
}

function registerResources(server: McpServer, host: PreparedBioMcpHost): void {
  server.registerResource(
    "pi-bio-manifest",
    new ResourceTemplate("pi-bio://manifests/{manifestId}", {
      list: async () => {
        const catalog = await hostCatalog(host);
        return {
          resources: catalog.entries.map((entry) => ({
            uri: manifestUri(entry.id),
            name: entry.title,
            title: entry.title,
            description: entry.description,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Pi Bio manifest",
      description: "A validated manifest from the host-approved catalog.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const manifestId = String(variables.manifestId);
      const manifest = await resolveManifest(host, manifestId);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: await fs.readFile(manifest.path, "utf8") }],
      };
    },
  );

  server.registerResource(
    "pi-bio-run-evidence",
    new ResourceTemplate("pi-bio://runs/{runId}/{part}", { list: undefined }),
    {
      title: "Pi Bio run evidence",
      description: "Exact persisted run, result, receipt, replay or CAS-reference JSON.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = String(variables.runId);
      const parsedPart = RUN_PART_SCHEMA.safeParse(String(variables.part));
      if (!parsedPart.success) throw new Error(`unsupported run evidence part '${String(variables.part)}'`);
      const evidence = await readRunPart(host, runId, parsedPart.data);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: evidence.text }],
      };
    },
  );
}

function registerTools(server: McpServer, host: PreparedBioMcpHost, requestContext?: McpRequestContext): void {
  server.registerTool(
    "bio_list_sources",
    {
      title: "List scientific sources",
      description: "List validated manifests from the fixed host catalog. Returns IDs and MCP resource URIs, never caller-selected filesystem roots.",
      inputSchema: z.object({
        query: z.string().optional().describe("Optional text filter over declarations."),
        includeInvalid: z.boolean().optional().describe("Include invalid manifest diagnostics."),
      }),
      outputSchema: MCP_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, includeInvalid }) => mcpResult(
      "manifest_catalog",
      transformedCatalog(await hostCatalog(host, query, includeInvalid ?? false)),
    ),
  );

  server.registerTool(
    "bio_describe_model",
    {
      title: "Describe a scientific manifest",
      description: "Validate and describe one manifest by catalog ID, including this host's capability admission assessment.",
      inputSchema: z.object({ manifestId: z.string().min(1) }),
      outputSchema: MCP_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ manifestId }, ctx) => {
      const manifest = await resolveManifest(host, manifestId);
      const external = externalCapabilities(host);
      const described = await describeBioManifestFromPath({
        cwd: host.cwd,
        manifestPath: manifest.manifestPath,
        network: external.network,
        compute: external.compute,
        resolverBindings: external.resolverBindings,
        signal: ctx.mcpReq.signal,
      });
      const { manifestPath: _manifestPath, ...description } = described;
      return mcpResult("manifest_description", {
        manifestId,
        resourceUri: manifestUri(manifestId),
        profile: host.profile,
        ...description,
      });
    },
  );

  if (host.profile === "exploratory") {
    server.registerTool(
      "bio_query",
      {
        title: "Run a read-only scientific query",
        description: "Resolve declared resources and execute one core-validated read-only SQL result statement. Use DESCRIBE or SUMMARIZE for schema discovery. Result delivery is explicitly full-inline or a durable evidence reference.",
        inputSchema: z.object({
          manifestId: z.string().min(1),
          sql: z.string().min(1),
          resources: z.array(z.string().min(1)).optional(),
          bindings: BINDINGS_SCHEMA.optional(),
          runId: z.string().regex(RUN_ID_RE).optional(),
          resultDelivery: RESULT_DELIVERY_SCHEMA.optional(),
        }),
        outputSchema: MCP_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ manifestId, sql, resources, bindings, runId, resultDelivery }, ctx) => {
        const manifest = await resolveManifest(host, manifestId);
        const response = await runBioQueryFromManifest({
          ...commonRunOptions(host, requestContext, ctx.mcpReq.signal),
          manifestPath: manifest.manifestPath,
          sql,
          resources,
          bindings,
          runId,
        });
        return mcpResult("query_run", projectRunResponse(response, resultDelivery ?? "reference"));
      },
    );
  }

  server.registerTool(
    "bio_run_operation",
    {
      title: "Run a declared scientific operation",
      description: "Execute a named, versioned duckdb.sql operation through the same public runner used by Pi.",
      inputSchema: z.object({
        manifestId: z.string().min(1),
        operationId: z.string().min(1),
        bindings: BINDINGS_SCHEMA.optional(),
        runId: z.string().regex(RUN_ID_RE).optional(),
        resultDelivery: RESULT_DELIVERY_SCHEMA.optional(),
      }),
      outputSchema: MCP_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ manifestId, operationId, bindings, runId, resultDelivery }, ctx) => {
      const manifest = await resolveManifest(host, manifestId);
      const response = await runBioOperationFromManifest({
        ...commonRunOptions(host, requestContext, ctx.mcpReq.signal),
        manifestPath: manifest.manifestPath,
        operationId,
        bindings,
        runId,
      });
      return mcpResult("operation_run", projectRunResponse(response, resultDelivery ?? "reference"));
    },
  );

  server.registerTool(
    "bio_get_run",
    {
      title: "Read persisted run evidence",
      description: "Read exact persisted evidence for one run ID. Missing parts are reported explicitly; scientific rows are never silently truncated.",
      inputSchema: z.object({
        runId: z.string().regex(RUN_ID_RE),
        include: z.array(RUN_PART_SCHEMA).optional(),
      }),
      outputSchema: MCP_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ runId, include }) => {
      const wanted = include ?? [...RUN_PARTS];
      const parts: Record<string, unknown> = {};
      const missing: string[] = [];
      for (const part of wanted) {
        try {
          parts[part] = (await readRunPart(host, runId, part)).value;
        } catch (error) {
          if (!isNotFound(error)) throw error;
          missing.push(part);
        }
      }
      return mcpResult("run_evidence", {
        runId,
        parts,
        missing,
        resources: Object.fromEntries(wanted.map((part) => [part, runPartUri(runId, part)])),
      });
    },
  );

  server.registerTool(
    "bio_reproduce_run",
    {
      title: "Reproduce a scientific run",
      description: "Load a persisted replay specification, re-execute it on a fresh database through the public SDK, and compare terminal outcome, receipts, result content and environment evidence.",
      inputSchema: z.object({ runId: z.string().regex(RUN_ID_RE) }),
      outputSchema: MCP_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ runId }, ctx) => {
      const replay = (await readRunPart(host, runId, "replay")).value as RunReplaySpec;
      const reproduced = await reproduceRun({
        ...commonReplayOptions(host, requestContext, ctx.mcpReq.signal),
        replay,
      });
      return mcpResult("reproduction", {
        ...reproduced,
        originalEvidence: runEvidenceUris(runId, replay.outcome?.status === "succeeded"),
        ...(reproduced.reproductionRunId
          ? { reproductionEvidence: runEvidenceUris(reproduced.reproductionRunId, reproduced.producedOutcome.status === "succeeded") }
          : {}),
      });
    },
  );
}

async function buildServer(host: PreparedBioMcpHost, requestContext?: McpRequestContext): Promise<McpServer> {
  const server = new McpServer(
    { name: "pi-bio-agent", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerResources(server, host);
  registerTools(server, host, requestContext);
  return server;
}

/** Build one MCP server instance. HTTP callers normally use createBioMcpHandler, whose factory calls this per request. */
export async function createBioMcpServer(options: BioMcpHostOptions, requestContext?: McpRequestContext): Promise<McpServer> {
  return buildServer(await prepareHost(options), requestContext);
}

/**
 * Create the final 2026-07-28 web-standard HTTP handler.
 *
 * The MCP SDK constructs a fresh server instance for every modern request. This adapter keeps no protocol session
 * table: durable scientific state lives in run files, CAS and the optional temporal store. Legacy traffic is rejected
 * unless the embedding host deliberately selects the SDK's stateless per-request fallback.
 */
export function createBioMcpHandler(options: BioMcpHostOptions): McpHttpHandler {
  const prepared = prepareHost(options);
  return createMcpHandler(
    async (requestContext) => buildServer(await prepared, requestContext),
    {
      legacy: options.legacy ?? "reject",
      responseMode: options.responseMode ?? "json",
      onerror: options.onerror,
    },
  );
}
