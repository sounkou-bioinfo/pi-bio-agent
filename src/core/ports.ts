import type { CasStore } from "./cas.js";
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
  /** Cooperative cancellation. A networked resolver (http.get) passes it to the injected fetch so an aborted
   *  tool call / a runaway request is torn down instead of running to completion. A resolver that can't honor
   *  it ignores it — cancellation is best-effort, not a correctness guarantee. */
  signal?: AbortSignal;
  /** CAS mode (host opt-in, like network). Present = a resolver snapshots its materialized bytes into the
   *  content-addressed store and scans FROM it (byte-perfect provenance + cross-db reuse). Absent = fast mode:
   *  scan the source directly, no snapshot. Reuse is for WHOLE objects (an API JSON response, a dump) — NOT a
   *  substitute for range/tabix access to a small region of a huge indexed file (that is duckhts' job). */
  cas?: CasStore;
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

/**
 * The PROCESS-RUNTIME port — the COMPUTE pillar's seam. A host-injected capability to run an OUT-OF-PROCESS
 * computation (R / Python / Go / shell), exactly like `fetch` is injected for the network: the agent's manifest
 * declares a `process.compute` resource, and without a ProcessRunner bound it FAILS CLOSED (the agent can never
 * spawn a process on its own). The runner only spawns and reports — it does NOT touch DuckDB. The resolver owns
 * the Arrow-IPC marshalling (DuckDB `COPY (sql) TO arrow_in (FORMAT arrow)`, the process computes, DuckDB
 * `read_arrow(arrow_out)`), so the DATA contract stays in SQL/Arrow and the runner stays a thin, auditable exec
 * boundary. Out-of-process, not FFI: a crash/OOM/timeout in the computation is contained in the child.
 */
export interface ProcessRunSpec {
  /** [executable, ...args] — an argv array, NEVER a shell string (so there is no shell to inject into). */
  command: readonly string[];
  cwd?: string;
  /** Extra environment for the child (merged over the host's) — tool knobs only; the Arrow in/out paths are passed
   *  as the last two ARGV entries (see process.compute), never via env. */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  /** The child's exit code, or null if it was killed by a signal/timeout. */
  exitCode: number | null;
  /** The signal that killed the child (e.g. "SIGKILL"), or null on a normal exit. Lets a caller distinguish an
   *  OOM/abort kill from a clean non-zero exit instead of reporting an opaque "exited null". */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessRunner {
  run(spec: ProcessRunSpec): Promise<ProcessRunResult>;
}
