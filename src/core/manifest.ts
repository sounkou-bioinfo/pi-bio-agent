import { createHash } from "node:crypto";
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
}
export interface TermSet {
  id: string;
  title: string;
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

/** Fail-closed structural validation of a manifest. Returns a list of errors ([] = valid). */
export function validateDomainPackManifest(manifest: DomainPackManifest): string[] {
  const errors: string[] = [];
  if (manifest?.schema !== DOMAIN_PACK_MANIFEST_SCHEMA) errors.push(`schema must be ${DOMAIN_PACK_MANIFEST_SCHEMA}`);
  if (typeof manifest?.id !== "string" || !manifest.id.trim()) errors.push("manifest id is required");
  if (typeof manifest?.version !== "string" || !manifest.version.trim()) errors.push("manifest version is required");

  const provides = manifest?.provides ?? {};
  const resources = provides.resources ?? [];
  const resolvers = provides.resolvers ?? [];
  const termSets = provides.termSets ?? [];
  const operations = provides.operations ?? [];

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
  }
  for (const res of resources) {
    if (res.kind !== "virtual") errors.push(`resource '${res.id}' must have kind 'virtual'`);
    if (!res.params || typeof res.params !== "object") errors.push(`resource '${res.id}' requires params object`);
    if (!resolverIds.has(res.resolver)) errors.push(`resource '${res.id}' points to undeclared resolver '${res.resolver}'`);
  }
  for (const ts of termSets) {
    if (!ts.title?.trim()) errors.push(`termSet '${ts.id}' requires a title`);
    const seenMembers = new Set<string>();
    for (const m of ts.members ?? []) {
      if (typeof m.id !== "string" || !m.id.trim()) errors.push(`termSet '${ts.id}' has a member with an empty id`);
      else if (seenMembers.has(m.id)) errors.push(`termSet '${ts.id}' has a duplicate member id '${m.id}'`);
      else seenMembers.add(m.id);
    }
  }
  const resourceIds = new Set(resources.map((r) => r.id));
  for (const op of operations) {
    for (const e of validateBioOperationSpec(op)) errors.push(`operation '${op.id}': ${e}`);
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
    getTermSet: (id) => termSets.get(id),
    getOperation: (id) => operations.get(id),
    async resolveResource(resourceId, ctx) {
      const resource = resources.get(resourceId);
      if (!resource) throw new Error(`no resource '${resourceId}' is registered`);
      const spec = resolverSpecs.get(resource.resolver);
      if (!spec) throw new Error(`resource '${resourceId}' points to unregistered resolver '${resource.resolver}'`);
      const impl = resolverImpls.get(resource.resolver);
      if (!impl) throw new Error(`resolver '${resource.resolver}' is declared but no implementation is bound`); // fail closed
      const now = ctx.now ?? new Date().toISOString();
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
