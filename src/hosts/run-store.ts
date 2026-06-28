import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type BioResolverImpl, type DomainPackManifest, type ResolutionReceipt } from "../core/manifest.js";
import { runOperation, type BucketedOperationReport, type OperationResult } from "../core/operations.js";
import type { BioRunRecord } from "../core/run-spec.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { duckdbFileScanResolver } from "../duckdb/resolvers/duckdb-file-scan.js";
import { duckhtsVcfScanResolver } from "../duckdb/resolvers/duckhts-vcf-scan.js";

// Host-level run runner + store. Core returns { run, result, report, receipts }; persistence and resolver
// binding live HERE, not in core. Only built-in resolver impls are bound; a manifest that declares any other
// resolver leaves it unbound and fails closed at resolve time.

const BUILTIN_RESOLVERS: Record<string, BioResolverImpl> = {
  "duckdb.file_scan": duckdbFileScanResolver,
  "duckhts.vcf_scan": duckhtsVcfScanResolver, // bound always; fails closed at resolve time if duckhts is not provisioned
};

// Built-in resolvers whose params.path is a file location to resolve relative to the manifest's directory.
const FILE_PATH_RESOLVERS = new Set(["duckdb.file_scan", "duckhts.vcf_scan"]);

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
  report?: BucketedOperationReport;
  receipts: ResolutionReceipt[];
}

export interface PersistedRun {
  dir: string;
  files: { run: string; result: string; receipts: string; report?: string };
}

/** Host-level persistence: write run/result/report/receipts under .pi/bio-agent/runs/<runId>/. */
export async function persistRun(cwd: string, runId: string, payload: RunPayload): Promise<PersistedRun> {
  const dir = join(runsRoot(cwd), runId);
  await fs.mkdir(dir, { recursive: true });
  const write = async (name: string, data: unknown): Promise<string> => {
    const path = join(dir, name);
    await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return path;
  };
  const files: PersistedRun["files"] = {
    run: await write("run.json", payload.run),
    result: await write("result.json", payload.result),
    receipts: await write("receipts.json", payload.receipts),
  };
  if (payload.report) files.report = await write("report.json", payload.report);
  return { dir, files };
}

export interface RunOperationRequest {
  cwd: string;
  dbPath: string; // explicit; ":memory:" or a path
  manifestPath: string;
  operationId: string;
  runId?: string;
  now?: string;
}

export interface RunOperationResponse {
  ok: true;
  runId: string;
  operationId: string;
  status: BioRunRecord["status"];
  rowCount: number;
  report?: { included: number; excluded: number; countsByBucket: Record<string, number>; caveats: string[] };
  artifacts: PersistedRun["files"];
  runDir: string;
}

function resolveInCwd(cwd: string, p: string): string {
  return p === ":memory:" || isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Host entry: load a manifest, register it (validated, fail closed), bind the built-in resolver impls it
 * declares, run a duckdb.sql operation against an explicit DuckDB database, and persist the run. Core is
 * unchanged — it returns { run, result, report, receipts }; binding + persistence are the host's job.
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
  for (const r of manifest.provides?.resolvers ?? []) {
    const impl = BUILTIN_RESOLVERS[r.id];
    if (impl) registry.bindResolverImpl(r.id, impl);
  }

  const op = registry.getOperation(req.operationId);
  if (!op) throw new Error(`operation '${req.operationId}' is not declared in the manifest`);
  if (op.transport !== "duckdb.sql" || !op.sql) throw new Error(`operation '${req.operationId}' is not a duckdb.sql operation`);

  const now = req.now ?? new Date().toISOString();
  const runId = req.runId ?? `${req.operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}`;

  const instance = await DuckDBInstance.create(resolveInCwd(req.cwd, req.dbPath));
  const conn = duckdbNodeConn(await instance.connect());

  const { run, result, report, receipts } = await runOperation(registry, conn, { operationId: req.operationId, runId, now });
  const persisted = await persistRun(req.cwd, runId, { run, result, report, receipts });

  return {
    ok: true,
    runId,
    operationId: req.operationId,
    status: run.status,
    rowCount: result.rows.length,
    report: report ? { included: report.included, excluded: report.excluded, countsByBucket: report.countsByBucket, caveats: report.caveats } : undefined,
    artifacts: persisted.files,
    runDir: persisted.dir,
  };
}
