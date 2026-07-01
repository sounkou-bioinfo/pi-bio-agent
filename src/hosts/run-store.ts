import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { systemClock } from "../core/clock.js";
import { RUN_REPLAY_SPEC_SCHEMA, receiptContentDigest, type RunReplaySpec, type EnvAttestationSummary } from "../core/reproducibility.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, describeManifest, validateBioManifest, type BioRegistry, type BioManifest, type ManifestDescription, type ResolutionReceipt } from "../core/manifest.js";
import { recordRunObservation, type RunObservation } from "./run-observations.js";
import type { CasStore } from "../core/cas.js";
import type { BioResolverImpl, ProcessRunner, SqlConn } from "../core/ports.js";
import { OperationRunError, runOperation, runQuery, type OperationResult } from "../core/operations.js";
import type { BioRunRecord } from "../core/run-spec.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { duckdbFileScanResolver } from "../duckdb/resolvers/duckdb-file-scan.js";
import { duckdbSqlMaterializeResolver } from "../duckdb/resolvers/duckdb-sql-materialize.js";
import { duckhtsReadBcfResolver } from "../duckdb/resolvers/duckhts-read-bcf.js";
import { httpTableResolver, type FetchLike } from "../duckdb/resolvers/http-table-scan.js";
import { processComputeResolver } from "../duckdb/resolvers/process-compute.js";

// Host-level run runner + store. Core returns { run, result, receipts }; persistence and resolver binding
// live HERE, not in core. Only built-in resolver impls are bound; a manifest that declares any other
// resolver leaves it unbound and fails closed at resolve time.

const BUILTIN_RESOLVERS: Record<string, BioResolverImpl> = {
  "duckdb.file_scan": duckdbFileScanResolver,
  "duckdb.sql_materialize": duckdbSqlMaterializeResolver, // the general resolver: materialization is declared SQL
  "duckhts.read_bcf": duckhtsReadBcfResolver, // bound always; fails closed at resolve time if duckhts is not provisioned
};

// http.get needs a host-supplied fetch to run at all (req.network) — that injection IS the network control,
// by construction, not a library egress firewall. file_scan / read_bcf may read remote URIs freely; whether
// egress is possible is the host's sandbox decision (container/seccomp/Pi/OS), not ours.
const NETWORK_RESOLVER = "http.get";
// The COMPUTE capability: a manifest's process.compute resource resolves only when the host injects a
// ProcessRunner (grants out-of-process compute by composition), exactly like http.get needs an injected fetch.
const PROCESS_RESOLVER = "process.compute";

// Built-in resolvers whose params.path is a file location to resolve relative to the manifest's directory.
const FILE_PATH_RESOLVERS = new Set(["duckdb.file_scan", "duckhts.read_bcf"]);

/**
 * Make relative local resource paths absolute, anchored to the MANIFEST's directory (not the Node process
 * cwd). Absolute paths and remote URIs (http(s)/s3/...) are left untouched. Host-level — core never touches
 * resolver params. Done before registration so the registry (and the receipt's paramsDigest) see the real path.
 */
function resolveResourcePaths(manifest: BioManifest, manifestDir: string): BioManifest {
  const resources = (manifest.provides?.resources ?? []).map((res) => {
    // process.compute: a script SHIPS WITH the manifest, referenced "./compute.R" — resolve such relative
    // command entries against the manifest dir (absolute paths and bare executable names are left untouched).
    if (res.resolver === PROCESS_RESOLVER) {
      const cmd = (res.params as { command?: unknown }).command;
      if (!Array.isArray(cmd)) return res;
      const command = cmd.map((c) => (typeof c === "string" && (c.startsWith("./") || c.startsWith("../"))) ? resolve(manifestDir, c) : c);
      return { ...res, params: { ...res.params, command } };
    }
    if (!FILE_PATH_RESOLVERS.has(res.resolver)) return res;
    const path = (res.params as { path?: unknown }).path;
    if (typeof path !== "string" || isAbsolute(path) || path.includes("://")) return res;
    return { ...res, params: { ...res.params, path: resolve(manifestDir, path) } };
  });
  return { ...manifest, provides: { ...manifest.provides, resources } };
}

export function runsRoot(cwd: string): string {
  return join(cwd, ".pi", "bio-agent", "runs");
}

const RUN_DIR_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Resolve a run's directory, refusing a runId that could escape runsRoot. Centralized so every persistence
 *  path (and the host runner) is path-safe, including the exported persist* helpers called directly. */
function runDir(cwd: string, runId: string): string {
  if (!RUN_DIR_ID_RE.test(runId)) throw new Error("runId must contain only [A-Za-z0-9._-] (no path separators)");
  return join(runsRoot(cwd), runId);
}

export interface RunPayload {
  run: BioRunRecord;
  result: OperationResult;
  receipts: ResolutionReceipt[];
}

export interface PersistedRun {
  dir: string;
  files: { run: string; result: string; receipts: string };
}

// DuckDB returns BIGINT/HUGEINT (e.g. a bare `count(*)`) as a JS BigInt, which JSON.stringify cannot
// serialize. The result IS the report and must be JSON, so a naive `count(*) AS n` must persist without the
// user knowing to `CAST(... AS INTEGER)`. Coerce BigInt → Number on the way to disk (bio counts/positions/
// frequencies are well within 2^53; a value needing exact larger-integer precision should be cast to text).
const bigintToNumber = (_key: string, value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value);

async function writeRunFile(dir: string, name: string, data: unknown): Promise<string> {
  const path = join(dir, name);
  await fs.writeFile(path, `${JSON.stringify(data, bigintToNumber, 2)}\n`, "utf8");
  return path;
}

/** Host-level persistence: write run/result/receipts under .pi/bio-agent/runs/<runId>/. result.json IS the
 *  report — whatever the operation's SQL returned. */
export async function persistRun(cwd: string, runId: string, payload: RunPayload): Promise<PersistedRun> {
  const dir = runDir(cwd, runId);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    files: {
      run: await writeRunFile(dir, "run.json", payload.run),
      result: await writeRunFile(dir, "result.json", payload.result),
      receipts: await writeRunFile(dir, "receipts.json", payload.receipts),
    },
  };
}

/** Persist a FAILED run: run.json (status "failed", carrying the error) + receipts.json for whatever resolved
 *  before the failure. No result.json — there is no answer. A failed run is still an auditable receipt. */
export async function persistFailedRun(cwd: string, runId: string, payload: { run: BioRunRecord; receipts: ResolutionReceipt[] }): Promise<{ dir: string; files: { run: string; receipts: string } }> {
  const dir = runDir(cwd, runId);
  await fs.mkdir(dir, { recursive: true });
  return {
    dir,
    files: {
      run: await writeRunFile(dir, "run.json", payload.run),
      receipts: await writeRunFile(dir, "receipts.json", payload.receipts),
    },
  };
}

export interface RunOperationRequest {
  cwd: string;
  dbPath: string; // explicit; ":memory:" or a path
  manifestPath: string;
  operationId: string;
  runId?: string;
  now?: string;
  /** Shared-store opt-in: when the host passes its bio_observations connection, the run records a `run:<id>` fact
   *  (status + SQL + digest refs, attributed to `author`) directly into the ONE store — no run.json read-back. */
  store?: SqlConn;
  author?: string;
  /** Network opt-in: pass a fetch to enable the http.get resolver. Absent = http.get stays unbound and any
   *  networked resource fails closed. The host (not core) owns this policy; nothing is read from ambient state. */
  network?: { fetch: FetchLike };
  /** COMPUTE opt-in (host grants out-of-process compute): pass a ProcessRunner to enable the process.compute resolver. Absent => process.compute stays unbound and fails closed. */
  process?: { runner: ProcessRunner };
  /** Cooperative cancellation, forwarded to each resolver (e.g. http.get's fetch). */
  signal?: AbortSignal;
  /** CAS mode (host opt-in): a content-addressed byte store. Present = resolvers snapshot bytes into it and
   *  reuse them across dbs/runs; absent = fast mode. */
  cas?: CasStore;
  /** Host-owned connection bootstrap SQL (INSTALL/LOAD/SET), run once before resolution — e.g. enabling
   *  httpfs + cache_httpfs so file_scan/sql_materialize remote reads get block caching. NOT agent SQL. */
  duckdbInitSql?: string[];
  /** Agent params as DuckDB session variables: each becomes `SET VARIABLE name = value`, so a resource url/body composes them with plain SQL (getvariable(name)) and upstream data with subqueries — no bespoke template DSL. */
  bindings?: Record<string, unknown>;
  /** Host DuckDB instance config set at db open (host-owned, never an agent param) — the home for credentials +
   *  startup settings: S3/object-store secrets, cache_httpfs cache dir, extension_directory, and
   *  allow_unsigned_extensions (for a cached/local dev extension build; community builds are signed). */
  duckdbConfig?: Record<string, string>;
}

export type RunOperationResponse =
  | { ok: true; runId: string; operationId: string; status: BioRunRecord["status"]; rowCount: number; artifacts: PersistedRun["files"]; runDir: string }
  | { ok: false; runId: string; operationId: string; status: BioRunRecord["status"]; error: string; runDir: string };

function resolveInCwd(cwd: string, p: string): string {
  return p === ":memory:" || isAbsolute(p) ? p : resolve(cwd, p);
}

/** Load + validate + register a manifest and bind the built-in resolver impls it declares. Shared by the
 *  operation and the ad-hoc query entry points. */
async function prepareRegistry(req: { cwd: string; manifestPath: string; network?: { fetch: FetchLike }; process?: { runner: ProcessRunner } }): Promise<{ registry: BioRegistry; manifest: BioManifest; raw: BioManifest; manifestDigest: string }> {
  const manifestPath = resolveInCwd(req.cwd, req.manifestPath);
  const text = await fs.readFile(manifestPath, "utf8");
  const raw = JSON.parse(text) as BioManifest; // the AUTHORED manifest — portable replay intent (relative paths intact)
  const manifestDigest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const manifest = resolveResourcePaths(raw, dirname(manifestPath)); // relative resource paths -> manifest dir (resolved execution facts)
  const registry = createBioRegistry();
  registry.registerManifest(manifest); // throws on an invalid manifest (fail closed)
  // Host-injected capability resolvers — present only when the host GRANTS them by composition; absent => the
  // declaring resource fails closed at resolve time.
  const injected: Record<string, BioResolverImpl | undefined> = {
    [NETWORK_RESOLVER]: req.network ? httpTableResolver(req.network.fetch) : undefined,
    [PROCESS_RESOLVER]: req.process ? processComputeResolver(req.process.runner) : undefined,
  };
  for (const r of manifest.provides?.resolvers ?? []) {
    const impl = BUILTIN_RESOLVERS[r.id] ?? injected[r.id];
    if (impl) registry.bindResolverImpl(r.id, impl);
  }
  return { registry, manifest, raw, manifestDigest };
}

/** Describe ONE manifest by path (resolved safely within cwd): parse, validate, and summarize its
 *  resources/operations (with the runnable operation ids)/resolvers/termSets. The agent's discovery path — learn
 *  what a manifest declares without reading raw JSON. Validation/parse failures are RETURNED, not thrown: a
 *  describe must never crash a probe. */
export async function describeBioManifestFromPath(req: { cwd: string; manifestPath: string; network?: { fetch: FetchLike } }): Promise<
  { manifestPath: string; valid: false; errors: string[] } | ({ manifestPath: string; valid: true } & ManifestDescription)
> {
  const isUrl = /^https?:\/\//i.test(req.manifestPath);
  let raw: BioManifest;
  try {
    let source: string;
    if (isUrl) {
      // A manifest can live remotely (a shared registry). Fetching it is the SAME host-granted network capability
      // as any connector — so it fails closed when the host injected no network (the default entrypoint), and
      // is available under the networked entrypoint. Never an ambient fetch.
      if (!req.network) return { manifestPath: req.manifestPath, valid: false, errors: ["a URL manifest needs host-granted network; the default entrypoint injects none (fail closed)"] };
      const res = await req.network.fetch(req.manifestPath, { method: "GET" });
      if (!res.ok) return { manifestPath: req.manifestPath, valid: false, errors: [`fetch failed: HTTP ${res.status}`] };
      source = await res.text();
    } else {
      source = await fs.readFile(resolveInCwd(req.cwd, req.manifestPath), "utf8");
    }
    raw = JSON.parse(source) as BioManifest;
  } catch (e) {
    return { manifestPath: req.manifestPath, valid: false, errors: [`not readable or not valid JSON: ${(e as Error).message}`] };
  }
  const errors = validateBioManifest(raw);
  if (errors.length) return { manifestPath: req.manifestPath, valid: false, errors };
  return { manifestPath: req.manifestPath, valid: true, ...describeManifest(raw) };
}

/** The RESOLVED process.compute facts for a run's resources (absolute command paths etc. — what actually ran on
 *  this host), captured beside the authored manifest snapshot so replay has BOTH portable intent and local facts.
 *  First process resource among `resources` (the walking-skeleton case; coloc/files-only declare one). */
function resolvedProcessFacts(manifest: BioManifest, resources: string[]): RunReplaySpec["process"] | undefined {
  const r = (manifest.provides?.resources ?? []).find((x) => x.resolver === PROCESS_RESOLVER && resources.includes(x.id));
  if (!r) return undefined;
  const p = r.params as { table?: string; command?: readonly string[]; inputSql?: string; resultTable?: "arrow" | "artifacts"; outputs?: Array<{ name: string; path: string; kind?: string }> };
  return { resourceId: r.id, table: p.table, command: p.command, inputSql: p.inputSql, resultTable: p.resultTable, outputs: p.outputs };
}

/** The env attestation SUMMARY lifted from the receipts' `environment` provenance entry (process.compute records
 *  it as notes). First process receipt that carries one (walking-skeleton: one process resource). */
function envSummaryFromReceipts(receipts: ResolutionReceipt[]): EnvAttestationSummary | undefined {
  for (const r of receipts) {
    const e = r.provenance.find((p) => p.source === "environment");
    const notes = e?.notes ?? [];
    const status = notes.find((n) => n.startsWith("env_status:"))?.slice("env_status:".length) as EnvAttestationSummary["status"] | undefined;
    if (!status) continue;
    const declaredDigest = notes.find((n) => n.startsWith("env_declared:"))?.slice("env_declared:".length);
    const observedDigest = notes.find((n) => n.startsWith("env_observed:"))?.slice("env_observed:".length);
    return { status, ...(declaredDigest ? { declaredDigest } : {}), ...(observedDigest ? { observedDigest } : {}) };
  }
  return undefined;
}

/** Enrich the pre-run replay SEED once receipts exist: pin the receipt digests + the env attestation summary, so
 *  reproduce() has stable handles and a status without re-parsing provenance. */
function enrichReplay(replay: RunReplaySpec, receipts: ResolutionReceipt[]): RunReplaySpec {
  const environment = envSummaryFromReceipts(receipts);
  return { ...replay, sourceReceiptDigests: receipts.map((r) => receiptContentDigest(r)), ...(environment ? { environment } : {}) };
}

/** Acquire → use → release: own a DuckDB instance/connection for one run, persist the result (or a failed-run
 *  receipt), and close on EVERY path so no handle leaks. `body` does the actual core run. */
/** Record a run as a `run:<id>` fact in the shared store, referencing the immutable content (receipt/manifest
 *  digests) — bytes stay in files/CAS outside. Best-effort: the shared-ledger log must never fail the run. */
async function recordRun(
  runLog: { store: SqlConn; author?: string } | undefined,
  now: string,
  args: { runId: string; identity: string; status: string; error: string | undefined; dir: string; replay?: RunReplaySpec; enriched?: RunReplaySpec },
): Promise<void> {
  if (!runLog) return;
  const obs: RunObservation = {
    runId: args.runId,
    kind: args.identity === "ad-hoc.query" ? "query" : "operation",
    identity: args.identity,
    status: args.status,
    sql: args.replay?.sql,
    resources: args.replay?.resources,
    error: args.error,
    runDir: args.dir,
    manifestDigest: args.replay?.manifest?.digest,
    sourceReceiptDigests: args.enriched?.sourceReceiptDigests,
  };
  try {
    await recordRunObservation(runLog.store, obs, now, runLog.author);
  } catch {
    /* best-effort: never fail a run because the shared-ledger log failed */
  }
}

async function runAndPersist(
  cwd: string, dbPath: string, runId: string, identity: string,
  body: (conn: SqlConn) => Promise<{ run: BioRunRecord; result: OperationResult; receipts: ResolutionReceipt[] }>,
  now: string,
  initSql?: string[],
  bindings?: Record<string, unknown>,
  duckdbConfig?: Record<string, string>,
  replay?: RunReplaySpec,
  runLog?: { store: SqlConn; author?: string },
): Promise<RunOperationResponse> {
  const instance = await DuckDBInstance.create(resolveInCwd(cwd, dbPath), duckdbConfig);
  const connection = await instance.connect();
  const conn = duckdbNodeConn(connection);
  try {
    // Host-owned connection bootstrap: INSTALL/LOAD/SET (e.g. httpfs + cache_httpfs, an extension dir, a memory
    // limit) run ONCE on this connection before any resolution. A failure here is a config/pre-flight error
    // (thrown, not a failed run): the run never started. This is HOST config, not agent SQL — no read-only
    // guard, by construction the agent cannot supply it (it is composed in at the host, like network/cas).
    if (initSql) for (const stmt of initSql) await conn.run(stmt);
    // Agent params are DuckDB SESSION VARIABLES, not a bespoke template DSL: the agent's bindings become
    // `SET VARIABLE name = value`, so a resource url/body composes them with plain SQL (`'…?q=' ||
    // getvariable('query')`) and upstream data with subqueries. The host sets them (bio_query is a single SELECT,
    // it can't); values are parameter-bound, so no injection.
    if (bindings) for (const [name, value] of Object.entries(bindings)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`binding name '${name}' must be a SQL identifier`);
      await conn.run(`SET VARIABLE ${name} = ?`, [value as never]);
    }
    try {
      const { run, result, receipts } = await body(conn);
      const persisted = await persistRun(cwd, runId, { run, result, receipts });
      // C1: seed the REPLAY bundle beside result/receipts — the actual inputs C2's reproduce() will re-execute,
      // ENRICHED now that receipts exist (their digests + the env attestation summary from provenance).
      const enriched = replay ? enrichReplay(replay, receipts) : undefined;
      if (enriched) await writeRunFile(persisted.dir, "replay.json", enriched);
      // Datomic + CAS: record the run as a fact in the ONE store, referencing content by digest (bytes stay outside).
      await recordRun(runLog, now, { runId, identity, status: run.status, error: undefined, dir: persisted.dir, replay, enriched });
      return { ok: true, runId, operationId: identity, status: run.status, rowCount: result.rows.length, artifacts: persisted.files, runDir: persisted.dir };
    } catch (error) {
      // A run that started and failed at runtime persists a failed-run receipt and returns ok:false; the
      // failure is auditable, not lost. Pre-flight/config errors (which never became a run) still throw.
      if (error instanceof OperationRunError) {
        const persisted = await persistFailedRun(cwd, runId, { run: error.run, receipts: error.receipts });
        const enriched = replay ? enrichReplay(replay, error.receipts) : undefined;
        if (enriched) await writeRunFile(persisted.dir, "replay.json", enriched); // a failed run is replayable too
        await recordRun(runLog, now, { runId, identity, status: error.run.status, error: error.message, dir: persisted.dir, replay, enriched });
        return { ok: false, runId, operationId: identity, status: error.run.status, error: error.message, runDir: persisted.dir };
      }
      throw error;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * Host entry: run a *declared* operation from a manifest and persist the run. A declared operation is a named,
 * tested, pinned query (the special case). For most questions use `runBioQueryFromManifest` — the agent writes
 * the SQL after schema discovery and the manifest declares only resources.
 */
export async function runBioOperationFromManifest(req: RunOperationRequest): Promise<RunOperationResponse> {
  if (req.runId !== undefined && !/^[A-Za-z0-9._-]+$/.test(req.runId)) {
    throw new Error("runId must contain only [A-Za-z0-9._-] (no path separators)"); // no run-dir traversal
  }
  const { registry, raw, manifest, manifestDigest } = await prepareRegistry(req);
  const op = registry.getOperation(req.operationId);
  if (!op) throw new Error(`operation '${req.operationId}' is not declared in the manifest`);
  if (op.transport !== "duckdb.sql" || !op.sql) throw new Error(`operation '${req.operationId}' is not a duckdb.sql operation`);
  const now = req.now ?? systemClock();
  // A HIGH-ENTROPY suffix, not just Date.now(): `run:<runId>` is the ledger statement_key, and in a SHARED store
  // (across projects/agents) a bare timestamp collides -> two unrelated runs would conflate into one as-of slot.
  const runId = req.runId ?? `${req.operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const allResources = (manifest.provides?.resources ?? []).map((r) => r.id);
  const proc = resolvedProcessFacts(manifest, allResources);
  const replay: RunReplaySpec = {
    schema: RUN_REPLAY_SPEC_SCHEMA, runId, kind: "operation",
    manifest: { digest: manifestDigest, snapshot: raw, path: req.manifestPath },
    operationId: req.operationId, sql: op.sql.sqlTemplate,
    ...(req.bindings ? { bindings: req.bindings } : {}), ...(req.duckdbInitSql ? { duckdbInitSql: req.duckdbInitSql } : {}),
    ...(proc ? { process: proc } : {}),
  };
  return runAndPersist(req.cwd, req.dbPath, runId, req.operationId, (conn) => runOperation(registry, conn, { operationId: req.operationId, runId, now, signal: req.signal, cas: req.cas }), now, req.duckdbInitSql, req.bindings, req.duckdbConfig, replay, req.store ? { store: req.store, author: req.author } : undefined);
}

export interface RunQueryRequest {
  cwd: string;
  dbPath: string;
  manifestPath: string;
  /** The read-only SQL to run — usually the AGENT's, written after schema discovery over the resolved tables. */
  sql: string;
  /** Which declared resources to materialize first; defaults to ALL the manifest declares, so the SQL may
   *  reference any of their tables. */
  resources?: string[];
  runId?: string;
  now?: string;
  /** Shared-store opt-in (see RunOperationRequest.store): record the run as a `run:<id>` fact in the ONE store. */
  store?: SqlConn;
  author?: string;
  network?: { fetch: FetchLike };
  /** COMPUTE opt-in (host grants out-of-process compute): pass a ProcessRunner to enable the process.compute resolver. Absent => process.compute stays unbound and fails closed. */
  process?: { runner: ProcessRunner };
  /** Cooperative cancellation, forwarded to each resolver (e.g. http.get's fetch). */
  signal?: AbortSignal;
  /** CAS mode (host opt-in): a content-addressed byte store for cross-db byte reuse. */
  cas?: CasStore;
  /** Host-owned connection bootstrap SQL (INSTALL/LOAD/SET), run once before resolution. NOT agent SQL. */
  duckdbInitSql?: string[];
  /** Agent params as DuckDB session variables: each becomes `SET VARIABLE name = value`, so a resource url/body composes them with plain SQL (getvariable(name)) and upstream data with subqueries — no bespoke template DSL. */
  bindings?: Record<string, unknown>;
  /** Host DuckDB instance config set at db open (host-owned, never an agent param) — the home for credentials +
   *  startup settings: S3/object-store secrets, cache_httpfs cache dir, extension_directory, and
   *  allow_unsigned_extensions (for a cached/local dev extension build; community builds are signed). */
  duckdbConfig?: Record<string, string>;
}

/**
 * Host entry: resolve a manifest's declared resources and run an AD-HOC read-only query over them — the
 * general path. The manifest needs to declare only resources (no operation per question); the agent does
 * schema discovery (e.g. a `SELECT … FROM information_schema.columns` or a `LIMIT` probe through this same
 * entry) and writes the SQL. Persists run/result/receipts exactly like an operation, with the SQL digest
 * pinned in provenance.
 */
export async function runBioQueryFromManifest(req: RunQueryRequest): Promise<RunOperationResponse> {
  if (req.runId !== undefined && !/^[A-Za-z0-9._-]+$/.test(req.runId)) {
    throw new Error("runId must contain only [A-Za-z0-9._-] (no path separators)");
  }
  const { registry, manifest, raw, manifestDigest } = await prepareRegistry(req);
  const resources = req.resources ?? (manifest.provides?.resources ?? []).map((r) => r.id);
  const now = req.now ?? systemClock();
  const runId = req.runId ?? `query-${Date.now()}-${randomUUID().slice(0, 8)}`; // globally unique: see runBioOperationFromManifest
  const proc = resolvedProcessFacts(manifest, resources);
  const replay: RunReplaySpec = {
    schema: RUN_REPLAY_SPEC_SCHEMA, runId, kind: "query",
    manifest: { digest: manifestDigest, snapshot: raw, path: req.manifestPath },
    sql: req.sql, resources,
    ...(req.bindings ? { bindings: req.bindings } : {}), ...(req.duckdbInitSql ? { duckdbInitSql: req.duckdbInitSql } : {}),
    ...(proc ? { process: proc } : {}),
  };
  return runAndPersist(req.cwd, req.dbPath, runId, "ad-hoc.query", (conn) => runQuery(registry, conn, { sql: req.sql, resources, runId, now, signal: req.signal, cas: req.cas }), now, req.duckdbInitSql, req.bindings, req.duckdbConfig, replay, req.store ? { store: req.store, author: req.author } : undefined);
}
