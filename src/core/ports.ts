import type { CasStore } from "./cas.js";
import type { ResourceHandle, SourceSnapshot, VirtualResourceSpec } from "./resources.js";
import type { Provenance } from "./types.js";
import type { EnvDescriptor } from "./reproducibility.js";

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
 * the temporal observation/graph store, so a fake in-memory port exercises all three in tests.
 */
export interface SqlConn {
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
}

export interface SqlConnPolicyContext {
  method: "all" | "run";
  sql: string;
  params?: readonly unknown[];
}

export type SqlConnPolicy = (ctx: SqlConnPolicyContext) => void | Promise<void>;

/** Wrap a SQL execution port with host-owned policy.
 *
 * This is intentionally only port composition. The library does not define a table-visibility taxonomy or a sandbox;
 * a host supplies the policy it actually needs, and the same wrapper covers query guards, audit hooks, subject-scoped
 * relation visibility, or deployment-specific denial rules.
 */
export function wrapSqlConn(inner: SqlConn, policy: SqlConnPolicy): SqlConn {
  return {
    all: async (sql, params) => {
      await policy({ method: "all", sql, params });
      return inner.all(sql, params);
    },
    run: async (sql, params) => {
      await policy({ method: "run", sql, params });
      return inner.run(sql, params);
    },
  };
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
  /** Cross-db remote-cache SCOPE (host-owned; fail-closed). The http.get resolver's per-db memo is safe (one db =
   *  one run = one auth context), but the CAS *cross-db* remote index (url→ETag+bytes, shared by every db on the
   *  root) is only safe when the response does not VARY by caller. A resolver cannot see this: host auth is
   *  injected by a fetch policy (withAuth) AFTER the resolver decides memoability, so an authenticated request
   *  looks header-free. So the cross-db index is consulted/populated ONLY when the host provides a scope, and it
   *  is keyed per-scope — a host partitions by auth principal (so tenant A's bytes never satisfy tenant B), or
   *  uses one constant scope (e.g. "public") for genuinely un-authenticated content to get full cross-db reuse.
   *  Absent → the shared index is skipped entirely (the per-db memo still works); no cross-scope leak is possible. */
  remoteCacheScope?: string;
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
 * Future-like async execution: submit returns a handle, status is a non-blocking observation, collect waits for
 * the value, and cancel is best-effort. This is the nanonext/mirai/future shape we want every long-running
 * execution surface to share; a local immediate runner is just the simplest backend, not a separate semantics.
 */
export interface AsyncRunner<Spec, Handle, Status, Result> {
  submit(spec: Spec): Promise<Handle>;
  status(handle: Handle): Promise<Status | null>;
  collect(handle: Handle): Promise<Result | null>;
  cancel?(handle: Handle): Promise<void>;
}

/**
 * The PROCESS-RUNTIME port — the COMPUTE pillar's seam. A host-injected capability to run an OUT-OF-PROCESS
 * computation (R / Python / Go / shell), exactly like `fetch` is injected for the network: the agent's manifest
 * declares a `compute.run` resource, and without a ComputeRunner bound it FAILS CLOSED (the agent can never
 * spawn a process on its own). The runner only accepts, reports, collects, and cancels work — it does NOT touch
 * DuckDB. The resolver owns the Arrow-IPC marshalling (DuckDB `COPY (sql) TO arrow_in (FORMAT arrow)`, the process
 * computes, DuckDB `read_arrow(arrow_out)`), so the DATA contract stays in SQL/Arrow and the runner stays a thin,
 * auditable exec boundary. Out-of-process, not FFI: a crash/OOM/timeout in the computation is contained in the
 * child. Long-running queue, NNG, stateful kernel, or local spawn backends must all present this same async shape.
 */
export interface ComputeTaskSpec {
  /** [executable, ...args] — an argv array, NEVER a shell string (so there is no shell to inject into). */
  command: readonly string[];
  cwd?: string;
  /** Extra environment for the child — tool knobs only; the Arrow in/out paths are passed as the last two ARGV
   *  entries (see compute.run), never via env. The child does NOT inherit the host's full `process.env` (that
   *  carries secrets); the runner gives it a minimal non-secret base (PATH/HOME/locale) plus exactly this. */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ComputeTaskResult {
  /** The child's exit code, or null if it was killed by a signal/timeout. */
  exitCode: number | null;
  /** The signal that killed the child (e.g. "SIGKILL"), or null on a normal exit. Lets a caller distinguish an
   *  OOM/abort kill from a clean non-zero exit instead of reporting an opaque "exited null". */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ComputeTaskPhase = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface ComputeTaskHandle {
  /** Host-assigned durable or in-memory handle. A local runner may use a UUID; a remote runner may use a queue id. */
  runId: string;
  submittedAt?: string;
  backend?: string;
}

export interface ComputeTaskStatus {
  runId: string;
  phase: ComputeTaskPhase;
  at?: string;
  progress?: { current?: number; total?: number; unit?: string };
  message?: string;
}

export interface ComputeRunner extends AsyncRunner<ComputeTaskSpec, ComputeTaskHandle, ComputeTaskStatus, ComputeTaskResult> {
  /** Collect waits for the process value, like future::value() / mirai::collect_mirai(). */
  collect(handle: ComputeTaskHandle): Promise<ComputeTaskResult>;
  /** OPTIONAL reproducibility probe (C1): describe the environment a run WOULD execute in, as an OBSERVED
   *  EnvDescriptor, for the declared-vs-observed attestation. Absent => compute.run records an explicit
   *  `unknown` observation, never a fake pin. MUST be cheap and side-effect-free — no spawning a version probe,
   *  no network, no mutation (a hanging/mutating probe is a host bug). A richer host provider may return more. */
  describeEnvironment?(spec: ComputeTaskSpec): Promise<EnvDescriptor>;
}

/** Convenience for synchronous consumers of the async process shape: submit work, then collect its value. */
export async function collectComputeTask(runner: ComputeRunner, spec: ComputeTaskSpec): Promise<ComputeTaskResult> {
  const handle = await runner.submit(spec);
  return runner.collect(handle);
}
