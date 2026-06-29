import { createHash } from "node:crypto";
import { systemClock } from "./clock.js";
import { validateBioOperationSpec, type BioOperationSpec } from "./operation-spec.js";
import type { BioResolverImpl, ResolutionContext } from "./ports.js";
import type { BioResolverSpec, ResourceHandle, SourceSnapshot, VirtualResourceSpec } from "./resources.js";
import type { Provenance } from "./types.js";

// The registration boundary: domain/operation packs declare serializable SPECS; a host binds executable
// IMPLS at runtime. Core never holds vendor logic or function refs in the snapshot — declarations are data
// (introspectable, graph-recordable), implementations are runtime bindings. The injection seams themselves
// (SqlConn, ResolutionContext, ResolverOutput, BioResolverImpl) live in ./ports.ts, the DI spine; this file
// orchestrates them. Resolution is resource-centered: the registry owns receipt metadata so a resolver impl
// cannot forge identity/provenance of what it resolved.

export type { BioResolverSpec, SourceSnapshot, VirtualResourceSpec } from "./resources.js";

export interface TermRef {
  id: string;
  label?: string;
  /** Position on an ordered scale (lowest = smallest). Required for every member of an `ordered` TermSet;
   *  ignored otherwise. The scale is DATA — ordering lives here, not in TypeScript. */
  rank?: number;
}
export interface TermSet {
  id: string;
  title: string;
  /** When true this is an ORDINAL SCALE: every member carries a unique integer `rank`, and the substrate
   *  materializes the set into the `scale_members` table so operation SQL can ORDER BY / threshold on rank.
   *  Membership grounding (decideGrounding) is unchanged; ordering is just the rank column. */
  ordered?: boolean;
  members: TermRef[];
}

export interface ResolutionReceipt {
  schema: "pi-bio.resolution_receipt.v1";
  resourceId: string;
  resolverId: string;
  resolverVersion: string;
  resolvedAt: string;
  paramsDigest: string;
  sourceSnapshots: SourceSnapshot[];
  result: ResourceHandle;
  provenance: Provenance[];
}

export const DOMAIN_PACK_MANIFEST_SCHEMA = "pi-bio.domain_pack_manifest.v1" as const;

export interface DomainPackManifest {
  schema: typeof DOMAIN_PACK_MANIFEST_SCHEMA;
  id: string;
  version: string;
  title: string;
  description: string;
  domains: string[];
  provides: {
    resources?: VirtualResourceSpec[];
    resolvers?: BioResolverSpec[];
    termSets?: TermSet[];
    operations?: BioOperationSpec[];
  };
}

export interface BioRegistrySnapshot {
  schema: "pi-bio.registry_snapshot.v1";
  manifests: Array<Pick<DomainPackManifest, "id" | "version" | "title" | "domains">>;
  resources: VirtualResourceSpec[];
  resolvers: BioResolverSpec[];
  termSets: TermSet[];
  operations: BioOperationSpec[];
}

export interface BioRegistry {
  registerManifest(manifest: DomainPackManifest): void;
  bindResolverImpl(resolverId: string, impl: BioResolverImpl, opts?: { replace?: boolean }): void;
  getResource(id: string): VirtualResourceSpec | undefined;
  getResolverSpec(id: string): BioResolverSpec | undefined;
  /** Whether a resolver id has an executable impl bound — a pre-flight runnability check, distinct from
   *  whether its spec is declared. A host that lacks the impl can't run the operation (config error). */
  hasResolverImpl(resolverId: string): boolean;
  getTermSet(id: string): TermSet | undefined;
  getOperation(id: string): BioOperationSpec | undefined;
  /** Resource-centered resolution. The registry stamps receipt metadata; impls only return resolved data. */
  resolveResource(resourceId: string, ctx: ResolutionContext): Promise<ResolutionReceipt>;
  /** Specs only — never functions, so it is JSON-serializable and graph-recordable. */
  snapshot(): BioRegistrySnapshot;
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** Stable digest of a resource's resolver params, for receipt-level distinguishability and caching. */
function paramsDigest(params: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(params)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// Strict admission: a manifest is the program, so only declared keys are allowed at every structural level
// — an unknown key fails closed rather than being silently ignored. This is what keeps cut sprawl OUT: a
// smuggled `reportKind`, `requiredColumns`, `columnRoles`, `mapper`, or `client` key is rejected here instead
// of riding along as inert JSON that a future reader might honor. Opacity is allowed in exactly two places:
// `resource.params` (opaque to core, handed to the resolver) and JSON Schemas (`inputSchema`/`outputSchema`).
function rejectUnknownKeys(obj: unknown, allowed: readonly string[], label: string, errors: string[]): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return; // wrong-type is reported by the field checks
  for (const k of Object.keys(obj as Record<string, unknown>)) {
    if (!allowed.includes(k)) errors.push(`${label} has unknown key '${k}' (allowed: ${allowed.join(", ")})`);
  }
}

/** Fail-closed structural validation of a manifest. Returns a list of errors ([] = valid). */
export function validateDomainPackManifest(manifest: DomainPackManifest): string[] {
  const errors: string[] = [];
  if (manifest?.schema !== DOMAIN_PACK_MANIFEST_SCHEMA) errors.push(`schema must be ${DOMAIN_PACK_MANIFEST_SCHEMA}`);
  if (typeof manifest?.id !== "string" || !manifest.id.trim()) errors.push("manifest id is required");
  if (typeof manifest?.version !== "string" || !manifest.version.trim()) errors.push("manifest version is required");
  if (typeof manifest?.title !== "string" || !manifest.title.trim()) errors.push("manifest title is required");
  if (typeof manifest?.description !== "string" || !manifest.description.trim()) errors.push("manifest description is required");
  if (!Array.isArray(manifest?.domains) || manifest.domains.length === 0) errors.push("manifest domains must be a non-empty array");
  rejectUnknownKeys(manifest, ["schema", "id", "version", "title", "description", "domains", "provides"], "manifest", errors);

  // Manifests come from JSON files — a malformed shape must produce a clean error, never a TypeError from
  // mapping a non-array. Treat a present-but-wrong-typed collection as an error and fall back to [] for the
  // rest of validation.
  const provides = manifest?.provides && typeof manifest.provides === "object" ? manifest.provides : {};
  if (manifest?.provides !== undefined && (typeof manifest.provides !== "object" || Array.isArray(manifest.provides))) errors.push("manifest.provides must be an object");
  rejectUnknownKeys(provides, ["resources", "resolvers", "termSets", "operations"], "manifest.provides", errors);
  const asArray = (v: unknown, label: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) { errors.push(`manifest.provides.${label} must be an array`); return []; }
    return v;
  };
  const resources = asArray(provides.resources, "resources") as VirtualResourceSpec[];
  const resolvers = asArray(provides.resolvers, "resolvers") as BioResolverSpec[];
  const termSets = asArray(provides.termSets, "termSets") as TermSet[];
  const operations = asArray(provides.operations, "operations") as BioOperationSpec[];

  const dupCheck = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !ID_RE.test(id)) errors.push(`${kind} has an invalid id '${id}'`);
      if (seen.has(id)) errors.push(`${kind} id '${id}' is duplicated within the manifest`);
      seen.add(id);
    }
  };
  dupCheck("resource", resources.map((r) => r.id));
  dupCheck("resolver", resolvers.map((r) => r.id));
  dupCheck("termSet", termSets.map((t) => t.id));
  dupCheck("operation", operations.map((o) => o.id));

  const resolverIds = new Set(resolvers.map((r) => r.id));
  for (const r of resolvers) {
    if (!r.title?.trim() || !r.description?.trim() || !r.version?.trim()) errors.push(`resolver '${r.id}' requires title, description, version`);
    if (!r.output?.mode) errors.push(`resolver '${r.id}' requires output.mode`);
    rejectUnknownKeys(r, ["id", "version", "title", "description", "output", "temporal"], `resolver '${r.id}'`, errors);
    rejectUnknownKeys(r.output, ["mode", "mediaType", "schemaRef"], `resolver '${r.id}'.output`, errors);
    if (r.temporal) rejectUnknownKeys(r.temporal, ["kind", "source", "versionRequired"], `resolver '${r.id}'.temporal`, errors);
  }
  for (const res of resources) {
    if (res.kind !== "virtual") errors.push(`resource '${res.id}' must have kind 'virtual'`);
    if (!res.params || typeof res.params !== "object") errors.push(`resource '${res.id}' requires params object`);
    if (!resolverIds.has(res.resolver)) errors.push(`resource '${res.id}' points to undeclared resolver '${res.resolver}'`);
    // params is OPAQUE to core (resolver's contract) — deliberately not key-checked.
    rejectUnknownKeys(res, ["id", "title", "kind", "resolver", "params", "schemaRef"], `resource '${res.id}'`, errors);
  }
  for (const ts of termSets) {
    if (!ts.title?.trim()) errors.push(`termSet '${ts.id}' requires a title`);
    rejectUnknownKeys(ts, ["id", "title", "ordered", "members"], `termSet '${ts.id}'`, errors);
    const seenMembers = new Set<string>();
    for (const m of ts.members ?? []) {
      if (typeof m.id !== "string" || !m.id.trim()) errors.push(`termSet '${ts.id}' has a member with an empty id`);
      else if (seenMembers.has(m.id)) errors.push(`termSet '${ts.id}' has a duplicate member id '${m.id}'`);
      else seenMembers.add(m.id);
      rejectUnknownKeys(m, ["id", "label", "rank"], `termSet '${ts.id}' member`, errors);
    }
    // An ordinal scale must carry a real total order: every member has a unique integer rank.
    if (ts.ordered) {
      const seenRanks = new Set<number>();
      for (const m of ts.members ?? []) {
        if (typeof m.rank !== "number" || !Number.isInteger(m.rank)) errors.push(`ordered termSet '${ts.id}' member '${m.id}' requires an integer rank`);
        else if (seenRanks.has(m.rank)) errors.push(`ordered termSet '${ts.id}' has a duplicate rank ${m.rank}`);
        else seenRanks.add(m.rank);
      }
    }
  }
  const resourceIds = new Set(resources.map((r) => r.id));
  for (const op of operations) {
    for (const e of validateBioOperationSpec(op)) errors.push(`operation '${op.id}': ${e}`);
    // inputSchema/outputSchema are JSON Schemas — opaque, not key-checked.
    rejectUnknownKeys(op, ["schema", "id", "version", "title", "description", "domains", "transport", "inputSchema", "outputSchema", "identifiers", "sql", "cache", "provenance", "notes"], `operation '${op.id}'`, errors);
    if (op.sql) rejectUnknownKeys(op.sql, ["sqlTemplate", "readOnly", "singleStatement", "requiredResources"], `operation '${op.id}'.sql`, errors);
    for (const rid of op.sql?.requiredResources ?? []) {
      if (!resourceIds.has(rid)) errors.push(`operation '${op.id}' requires undeclared resource '${rid}'`);
    }
  }
  return errors;
}

export function createBioRegistry(): BioRegistry {
  const manifestIds = new Set<string>();
  const manifests: DomainPackManifest[] = [];
  const resources = new Map<string, VirtualResourceSpec>();
  const resolverSpecs = new Map<string, BioResolverSpec>();
  const resolverImpls = new Map<string, BioResolverImpl>();
  const termSets = new Map<string, TermSet>();
  const operations = new Map<string, BioOperationSpec>();

  return {
    registerManifest(manifest) {
      const errors = validateDomainPackManifest(manifest);
      if (errors.length) throw new Error(`invalid manifest '${manifest?.id ?? "<unknown>"}': ${errors.join("; ")}`);
      // Preflight ALL collisions before mutating any map, so a failed manifest leaves the registry untouched.
      if (manifestIds.has(manifest.id)) throw new Error(`manifest id '${manifest.id}' is already registered`);
      const collisions: Array<[Map<string, { id: string }>, string]> = [
        ...(manifest.provides.resolvers ?? []).map((r) => [resolverSpecs, r.id] as [Map<string, { id: string }>, string]),
        ...(manifest.provides.resources ?? []).map((r) => [resources, r.id] as [Map<string, { id: string }>, string]),
        ...(manifest.provides.termSets ?? []).map((t) => [termSets, t.id] as [Map<string, { id: string }>, string]),
        ...(manifest.provides.operations ?? []).map((o) => [operations, o.id] as [Map<string, { id: string }>, string]),
      ];
      for (const [map, id] of collisions) {
        if (map.has(id)) throw new Error(`cannot register manifest '${manifest.id}': id '${id}' is already registered`);
      }
      // Clone + freeze so a caller cannot mutate the registry's view of a spec after the fact.
      const frozen = deepFreeze(JSON.parse(JSON.stringify(manifest)) as DomainPackManifest);
      for (const r of frozen.provides.resolvers ?? []) resolverSpecs.set(r.id, r);
      for (const r of frozen.provides.resources ?? []) resources.set(r.id, r);
      for (const t of frozen.provides.termSets ?? []) termSets.set(t.id, t);
      for (const o of frozen.provides.operations ?? []) operations.set(o.id, o);
      manifestIds.add(frozen.id);
      manifests.push(frozen);
    },
    bindResolverImpl(resolverId, impl, opts) {
      if (!resolverSpecs.has(resolverId)) throw new Error(`cannot bind impl: no resolver spec '${resolverId}' is registered`);
      if (resolverImpls.has(resolverId) && !opts?.replace) throw new Error(`resolver '${resolverId}' already has a bound impl (pass { replace: true } to override)`);
      resolverImpls.set(resolverId, impl);
    },
    getResource: (id) => resources.get(id),
    getResolverSpec: (id) => resolverSpecs.get(id),
    hasResolverImpl: (id) => resolverImpls.has(id),
    getTermSet: (id) => termSets.get(id),
    getOperation: (id) => operations.get(id),
    async resolveResource(resourceId, ctx) {
      const resource = resources.get(resourceId);
      if (!resource) throw new Error(`no resource '${resourceId}' is registered`);
      const spec = resolverSpecs.get(resource.resolver);
      if (!spec) throw new Error(`resource '${resourceId}' points to unregistered resolver '${resource.resolver}'`);
      const impl = resolverImpls.get(resource.resolver);
      if (!impl) throw new Error(`resolver '${resource.resolver}' is declared but no implementation is bound`); // fail closed
      const now = ctx.now ?? systemClock();
      const out = await impl(resource, ctx);
      return {
        schema: "pi-bio.resolution_receipt.v1",
        resourceId,
        resolverId: spec.id,
        resolverVersion: spec.version,
        resolvedAt: now,
        paramsDigest: paramsDigest(resource.params),
        sourceSnapshots: out.sourceSnapshots,
        result: out.result,
        provenance: out.provenance,
      };
    },
    snapshot() {
      return {
        schema: "pi-bio.registry_snapshot.v1",
        manifests: manifests.map(({ id, version, title, domains }) => ({ id, version, title, domains })),
        resources: [...resources.values()],
        resolvers: [...resolverSpecs.values()],
        termSets: [...termSets.values()],
        operations: [...operations.values()],
      };
    },
  };
}
