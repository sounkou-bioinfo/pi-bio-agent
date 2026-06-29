import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type DomainPackManifest, type ResolutionReceipt } from "../core/manifest.js";
import type { BioResolverImpl } from "../core/ports.js";
import { OperationRunError, runOperation, type OperationResult } from "../core/operations.js";
import type { BioRunRecord } from "../core/run-spec.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { duckdbFileScanResolver } from "../duckdb/resolvers/duckdb-file-scan.js";
import { duckhtsReadBcfResolver } from "../duckdb/resolvers/duckhts-read-bcf.js";
import { httpTableResolver, type FetchLike } from "../duckdb/resolvers/http-table-scan.js";

// Host-level run runner + store. Core returns { run, result, receipts }; persistence and resolver binding
// live HERE, not in core. Only built-in resolver impls are bound; a manifest that declares any other
// resolver leaves it unbound and fails closed at resolve time.

const BUILTIN_RESOLVERS: Record<string, BioResolverImpl> = {
  "duckdb.file_scan": duckdbFileScanResolver,
  "duckhts.read_bcf": duckhtsReadBcfResolver, // bound always; fails closed at resolve time if duckhts is not provisioned
};

// http.get is NOT a default built-in: it is bound only when the caller passes a fetch (req.network), which IS
// the network opt-in. Without it, a manifest that declares http.get leaves it unbound and fails closed — no
// ambient network from a host run.
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

export interface RunPayload {
  run: BioRunRecord;
  result: OperationResult;
  receipts: ResolutionReceipt[];
}

export interface PersistedRun {
  dir: string;
  files: { run: string; result: string; receipts: string };
}

async function writeRunFile(dir: string, name: string, data: unknown): Promise<string> {
  const path = join(dir, name);
  await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path;
}

/** Host-level persistence: write run/result/receipts under .pi/bio-agent/runs/<runId>/. result.json IS the
 *  report — whatever the operation's SQL returned. */
export async function persistRun(cwd: string, runId: string, payload: RunPayload): Promise<PersistedRun> {
  const dir = join(runsRoot(cwd), runId);
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
  const dir = join(runsRoot(cwd), runId);
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
}

export type RunOperationResponse =
  | { ok: true; runId: string; operationId: string; status: BioRunRecord["status"]; rowCount: number; artifacts: PersistedRun["files"]; runDir: string }
  | { ok: false; runId: string; operationId: string; status: BioRunRecord["status"]; error: string; runDir: string };

function resolveInCwd(cwd: string, p: string): string {
  return p === ":memory:" || isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Host entry: load a manifest, register it (validated, fail closed), bind the built-in resolver impls it
 * declares, run a duckdb.sql operation against an explicit DuckDB database, and persist the run. Core is
 * unchanged — it returns { run, result, receipts }; binding + persistence are the host's job.
 */
export async function runBioOperationFromManifest(req: RunOperationRequest): Promise<RunOperationResponse> {
  if (req.runId !== undefined && !/^[A-Za-z0-9._-]+$/.test(req.runId)) {
    throw new Error("runId must contain only [A-Za-z0-9._-] (no path separators)"); // no run-dir traversal
  }
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

  const op = registry.getOperation(req.operationId);
  if (!op) throw new Error(`operation '${req.operationId}' is not declared in the manifest`);
  if (op.transport !== "duckdb.sql" || !op.sql) throw new Error(`operation '${req.operationId}' is not a duckdb.sql operation`);

  const now = req.now ?? new Date().toISOString();
  const runId = req.runId ?? `${req.operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}`;

  // Acquire → use → release: the DuckDB instance/connection are owned for the duration of this run and closed
  // on EVERY path (success, failed run, or rethrow) so a run never leaks a handle or holds a file-db lock.
  const instance = await DuckDBInstance.create(resolveInCwd(req.cwd, req.dbPath));
  const connection = await instance.connect();
  const conn = duckdbNodeConn(connection);

  try {
    try {
      const { run, result, receipts } = await runOperation(registry, conn, { operationId: req.operationId, runId, now });
      const persisted = await persistRun(req.cwd, runId, { run, result, receipts });
      return { ok: true, runId, operationId: req.operationId, status: run.status, rowCount: result.rows.length, artifacts: persisted.files, runDir: persisted.dir };
    } catch (error) {
      // A run that started and failed at runtime persists a failed-run receipt and returns ok:false — the
      // failure is auditable, not lost. Pre-flight/config errors (which never became a run) still throw.
      if (error instanceof OperationRunError) {
        const persisted = await persistFailedRun(req.cwd, runId, { run: error.run, receipts: error.receipts });
        return { ok: false, runId, operationId: req.operationId, status: error.run.status, error: error.message, runDir: persisted.dir };
      }
      throw error;
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
