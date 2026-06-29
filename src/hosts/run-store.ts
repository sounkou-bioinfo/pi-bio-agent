import { promises as fs } from "node:fs";
import { systemClock } from "../core/clock.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type BioRegistry, type DomainPackManifest, type ResolutionReceipt } from "../core/manifest.js";
import type { CasStore } from "../core/cas.js";
import type { BioResolverImpl, SqlConn } from "../core/ports.js";
import { OperationRunError, runOperation, runQuery, type OperationResult } from "../core/operations.js";
import type { BioRunRecord } from "../core/run-spec.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { duckdbFileScanResolver } from "../duckdb/resolvers/duckdb-file-scan.js";
import { duckdbSqlMaterializeResolver } from "../duckdb/resolvers/duckdb-sql-materialize.js";
import { duckhtsReadBcfResolver } from "../duckdb/resolvers/duckhts-read-bcf.js";
import { httpTableResolver, type FetchLike } from "../duckdb/resolvers/http-table-scan.js";

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

// Built-in resolvers whose params.path is a file location to resolve relative to the manifest's directory.
const FILE_PATH_RESOLVERS = new Set(["duckdb.file_scan", "duckhts.read_bcf"]);

/**
 * Make relative local resource paths absolute, anchored to the MANIFEST's directory (not the Node process
 * cwd). Absolute paths and remote URIs (http(s)/s3/...) are left untouched. Host-level — core never touches
 * resolver params. Done before registration so the registry (and the receipt's paramsDigest) see the real path.
 */
function resolveResourcePaths(manifest: DomainPackManifest, manifestDir: string): DomainPackManifest {
  const resources = (manifest.provides?.resources ?? []).map((res) => {
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
  /** Network opt-in: pass a fetch to enable the http.get resolver. Absent = http.get stays unbound and any
   *  networked resource fails closed. The host (not core) owns this policy; nothing is read from ambient state. */
  network?: { fetch: FetchLike };
  /** Cooperative cancellation, forwarded to each resolver (e.g. http.get's fetch). */
  signal?: AbortSignal;
  /** CAS mode (host opt-in): a content-addressed byte store. Present = resolvers snapshot bytes into it and
   *  reuse them across dbs/runs; absent = fast mode. */
  cas?: CasStore;
  /** Host-owned connection bootstrap SQL (INSTALL/LOAD/SET), run once before resolution — e.g. enabling
   *  httpfs + cache_httpfs so file_scan/sql_materialize remote reads get block caching. NOT agent SQL. */
  duckdbInitSql?: string[];
}

export type RunOperationResponse =
  | { ok: true; runId: string; operationId: string; status: BioRunRecord["status"]; rowCount: number; artifacts: PersistedRun["files"]; runDir: string }
  | { ok: false; runId: string; operationId: string; status: BioRunRecord["status"]; error: string; runDir: string };

function resolveInCwd(cwd: string, p: string): string {
  return p === ":memory:" || isAbsolute(p) ? p : resolve(cwd, p);
}

/** Load + validate + register a manifest and bind the built-in resolver impls it declares. Shared by the
 *  operation and the ad-hoc query entry points. */
async function prepareRegistry(req: { cwd: string; manifestPath: string; network?: { fetch: FetchLike } }): Promise<{ registry: BioRegistry; manifest: DomainPackManifest }> {
  const manifestPath = resolveInCwd(req.cwd, req.manifestPath);
  const raw = JSON.parse(await fs.readFile(manifestPath, "utf8")) as DomainPackManifest;
  const manifest = resolveResourcePaths(raw, dirname(manifestPath)); // relative resource paths -> manifest dir
  const registry = createBioRegistry();
  registry.registerManifest(manifest); // throws on an invalid manifest (fail closed)
  const httpImpl = req.network ? httpTableResolver(req.network.fetch) : undefined;
  for (const r of manifest.provides?.resolvers ?? []) {
    const impl = BUILTIN_RESOLVERS[r.id] ?? (r.id === NETWORK_RESOLVER ? httpImpl : undefined);
    if (impl) registry.bindResolverImpl(r.id, impl);
  }
  return { registry, manifest };
}

/** Acquire → use → release: own a DuckDB instance/connection for one run, persist the result (or a failed-run
 *  receipt), and close on EVERY path so no handle leaks. `body` does the actual core run. */
async function runAndPersist(
  cwd: string, dbPath: string, runId: string, identity: string,
  body: (conn: SqlConn) => Promise<{ run: BioRunRecord; result: OperationResult; receipts: ResolutionReceipt[] }>,
  initSql?: string[],
): Promise<RunOperationResponse> {
  const instance = await DuckDBInstance.create(resolveInCwd(cwd, dbPath));
  const connection = await instance.connect();
  const conn = duckdbNodeConn(connection);
  try {
    // Host-owned connection bootstrap: INSTALL/LOAD/SET (e.g. httpfs + cache_httpfs, an extension dir, a memory
    // limit) run ONCE on this connection before any resolution. A failure here is a config/pre-flight error
    // (thrown, not a failed run): the run never started. This is HOST config, not agent SQL — no read-only
    // guard, by construction the agent cannot supply it (it is composed in at the host, like network/cas).
    if (initSql) for (const stmt of initSql) await conn.run(stmt);
    try {
      const { run, result, receipts } = await body(conn);
      const persisted = await persistRun(cwd, runId, { run, result, receipts });
      return { ok: true, runId, operationId: identity, status: run.status, rowCount: result.rows.length, artifacts: persisted.files, runDir: persisted.dir };
    } catch (error) {
      // A run that started and failed at runtime persists a failed-run receipt and returns ok:false; the
      // failure is auditable, not lost. Pre-flight/config errors (which never became a run) still throw.
      if (error instanceof OperationRunError) {
        const persisted = await persistFailedRun(cwd, runId, { run: error.run, receipts: error.receipts });
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
  const { registry } = await prepareRegistry(req);
  const op = registry.getOperation(req.operationId);
  if (!op) throw new Error(`operation '${req.operationId}' is not declared in the manifest`);
  if (op.transport !== "duckdb.sql" || !op.sql) throw new Error(`operation '${req.operationId}' is not a duckdb.sql operation`);
  const now = req.now ?? systemClock();
  const runId = req.runId ?? `${req.operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}`;
  return runAndPersist(req.cwd, req.dbPath, runId, req.operationId, (conn) => runOperation(registry, conn, { operationId: req.operationId, runId, now, signal: req.signal, cas: req.cas }), req.duckdbInitSql);
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
  network?: { fetch: FetchLike };
  /** Cooperative cancellation, forwarded to each resolver (e.g. http.get's fetch). */
  signal?: AbortSignal;
  /** CAS mode (host opt-in): a content-addressed byte store for cross-db byte reuse. */
  cas?: CasStore;
  /** Host-owned connection bootstrap SQL (INSTALL/LOAD/SET), run once before resolution. NOT agent SQL. */
  duckdbInitSql?: string[];
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
  const { registry, manifest } = await prepareRegistry(req);
  const resources = req.resources ?? (manifest.provides?.resources ?? []).map((r) => r.id);
  const now = req.now ?? systemClock();
  const runId = req.runId ?? `query-${Date.now()}`;
  return runAndPersist(req.cwd, req.dbPath, runId, "ad-hoc.query", (conn) => runQuery(registry, conn, { sql: req.sql, resources, runId, now, signal: req.signal, cas: req.cas }), req.duckdbInitSql);
}
