import type { ResourceHandle, SourceSnapshot, VirtualResourceSpec } from "./resources.js";
import type { Provenance } from "./types.js";

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// PORTS — the boundary contracts a HOST implements and injects. This file is the dependency-injection spine.
//
// The bet: manifests / SQL / resources / ontology data are the PROGRAM; TypeScript is the interpreter. Core
// declares these seams and ORCHESTRATES them; it never constructs a backend, a resolver, or a model client.
// A host supplies the adapters and passes them in. The principles we rely on, made explicit:
//
//   1. No ambient globals. A registry, a connection, a clock, a judge are explicit arguments — never module
//      state, env lookups, or singletons. Two runs never share hidden state, so a run is reproducible.
//   2. Specs are data; impls are runtime bindings. A manifest declares serializable BioResolverSpecs; the
//      executable BioResolverImpl is bound by a host at runtime (registry.bindResolverImpl). The registry
//      snapshot is JSON — no function ever leaks into it, so the program stays introspectable/graph-recordable.
//   3. Identity is stamped by the substrate, not the adapter. A resolver impl returns only the data it
//      resolved (ResolverOutput); the registry stamps resourceId / resolver version / paramsDigest into the
//      receipt, so an impl cannot forge the provenance of what it produced.
//   4. Fail closed at every seam. An unbound impl, a missing resource, an unprovisioned extension THROW —
//      they never silently no-op or fall back to a default.
//
// The ports a host implements:
//   • SqlConn         — the execution backend      (adapter: duckdbNodeConn over @duckdb/node-api)
//   • BioResolverImpl — a resource resolver/reader  (adapters: duckdbFileScanResolver, duckhtsReadBcfResolver)
//   • BioJudgeImpl    — a model-backed judge        (declared in judgment.ts, beside its deterministic decider)
//
// Extension points — where new capability enters WITHOUT new core code (the extensible domain bet):
//   new question / domain → a new manifest (data)        new format / source → a new BioResolverImpl (adapter)
//   new analysis          → operation SQL (data)          new backend         → a new SqlConn (adapter)
// If a new question or source needs a new core .ts file instead of a manifest/SQL/adapter, that is the bet
// failing — stop and redesign it as data.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The execution-backend port — the single seam the package speaks to data through, never a concrete driver.
 * A DuckDB connection is structurally one. Used identically by the operation runner, schema discovery, and
 * the KG sync, so a fake in-memory port exercises all three in tests.
 */
export interface SqlConn {
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
}

/**
 * What a host passes into a resolution: the execution port plus an injectable clock for deterministic
 * receipts/tests. Deliberately spare — no policy, no network handle, no secrets. A resolver reads only what
 * its own spec's params declare; anything ambient would be an invisible, unreceipted dependency.
 */
export interface ResolutionContext {
  conn: SqlConn;
  /** Injectable clock for deterministic receipts/tests. */
  now?: string;
}

/**
 * What a resolver impl returns — the data it actually resolved, nothing more. The registry stamps the
 * identity/provenance metadata (resourceId, resolverId/version, resolvedAt, paramsDigest) into the receipt,
 * so an impl cannot misattribute what it produced.
 */
export interface ResolverOutput {
  result: ResourceHandle;
  sourceSnapshots: SourceSnapshot[];
  provenance: Provenance[];
}

/**
 * The resolver port: a host-bound function that turns a declared resource into a materialized handle. Bound
 * at runtime via the registry; never present in a manifest or a snapshot (those carry only the BioResolverSpec).
 */
export type BioResolverImpl = (resource: VirtualResourceSpec, ctx: ResolutionContext) => Promise<ResolverOutput>;
