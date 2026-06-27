import type { BioOperationSpec } from "./operation-spec.js";
import type { ResourceHandle } from "./resources.js";
import type { Provenance } from "./types.js";

// The registration boundary: domain/operation packs declare serializable SPECS; a host binds executable
// IMPLS at runtime. Core never holds vendor logic or function refs in the snapshot — declarations are data
// (introspectable, graph-recordable), implementations are runtime bindings. No ambient globals: a registry
// is an explicit object passed into runners/tests/hosts.

/** Minimal SQL execution port (the execution-backend contract). A DuckDB connection is structurally one. */
export interface SqlConn {
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
}

export interface SourceSnapshot {
  source: string;
  version?: string;
  releasedAt?: string;
  retrievedAt?: string;
}

export interface TermRef {
  id: string;
  label?: string;
}
export interface TermSet {
  id: string;
  title: string;
  members: TermRef[];
}

export interface BioViewDef {
  id: string;
  name: string;
  description: string;
  columns: Array<{ name: string; type: "TEXT" | "INTEGER" | "DOUBLE" | "BOOLEAN" | "JSON"; nullable?: boolean; description?: string }>;
}

/** Declaration of a resolver — serializable, lives in a manifest. The implementation is bound separately. */
export interface BioResolverSpec {
  id: string;
  version: string;
  title: string;
  description: string;
  output: { mode: "inline" | "reference" | "content_address" | "table"; mediaType?: string; schemaRef?: string };
  temporal?: { kind: "snapshot" | "live" | "as_of"; source?: string; versionRequired?: boolean };
}

export interface ResolutionContext {
  conn: SqlConn;
  /** Injectable clock for deterministic receipts/tests. */
  now?: string;
}

export interface ResolutionReceipt {
  schema: "pi-bio.resolution_receipt.v1";
  resolverId: string;
  resolverVersion: string;
  resolvedAt: string;
  query: Record<string, unknown>;
  sourceSnapshots: SourceSnapshot[];
  result: ResourceHandle;
  provenance: Provenance[];
}

export type BioResolverImpl = (query: Record<string, unknown>, ctx: ResolutionContext) => Promise<ResolutionReceipt>;

export interface DomainPackManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  domains: string[];
  provides: {
    resolvers?: BioResolverSpec[];
    views?: BioViewDef[];
    termSets?: TermSet[];
    operations?: BioOperationSpec[];
  };
}

export interface BioRegistrySnapshot {
  schema: "pi-bio.registry_snapshot.v1";
  manifests: Array<Pick<DomainPackManifest, "id" | "version" | "title" | "domains">>;
  resolvers: BioResolverSpec[];
  views: BioViewDef[];
  termSets: TermSet[];
  operations: BioOperationSpec[];
}

export interface BioRegistry {
  registerManifest(manifest: DomainPackManifest): void;
  bindResolverImpl(resolverId: string, impl: BioResolverImpl): void;
  getResolverSpec(id: string): BioResolverSpec | undefined;
  getTermSet(id: string): TermSet | undefined;
  getView(id: string): BioViewDef | undefined;
  getOperation(id: string): BioOperationSpec | undefined;
  resolve(resolverId: string, query: Record<string, unknown>, ctx: ResolutionContext): Promise<ResolutionReceipt>;
  /** Specs only — never functions, so it is JSON-serializable and graph-recordable. */
  snapshot(): BioRegistrySnapshot;
}

export function createBioRegistry(): BioRegistry {
  const manifests: DomainPackManifest[] = [];
  const resolverSpecs = new Map<string, BioResolverSpec>();
  const resolverImpls = new Map<string, BioResolverImpl>();
  const termSets = new Map<string, TermSet>();
  const views = new Map<string, BioViewDef>();
  const operations = new Map<string, BioOperationSpec>();

  return {
    registerManifest(manifest) {
      manifests.push(manifest);
      for (const r of manifest.provides.resolvers ?? []) resolverSpecs.set(r.id, r);
      for (const t of manifest.provides.termSets ?? []) termSets.set(t.id, t);
      for (const v of manifest.provides.views ?? []) views.set(v.id, v);
      for (const o of manifest.provides.operations ?? []) operations.set(o.id, o);
    },
    bindResolverImpl(resolverId, impl) {
      if (!resolverSpecs.has(resolverId)) throw new Error(`cannot bind impl: no resolver spec '${resolverId}' is registered`);
      resolverImpls.set(resolverId, impl);
    },
    getResolverSpec: (id) => resolverSpecs.get(id),
    getTermSet: (id) => termSets.get(id),
    getView: (id) => views.get(id),
    getOperation: (id) => operations.get(id),
    async resolve(resolverId, query, ctx) {
      if (!resolverSpecs.has(resolverId)) throw new Error(`no resolver spec '${resolverId}' is registered`);
      const impl = resolverImpls.get(resolverId);
      if (!impl) throw new Error(`resolver '${resolverId}' is declared but no implementation is bound`); // fail closed
      return impl(query, ctx);
    },
    snapshot() {
      return {
        schema: "pi-bio.registry_snapshot.v1",
        manifests: manifests.map(({ id, version, title, domains }) => ({ id, version, title, domains })),
        resolvers: [...resolverSpecs.values()],
        views: [...views.values()],
        termSets: [...termSets.values()],
        operations: [...operations.values()],
      };
    },
  };
}
