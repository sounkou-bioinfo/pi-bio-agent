import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { systemClock } from "../core/clock.js";
import { RUN_REPLAY_SPEC_SCHEMA, receiptContentDigest, canonicalDigest, type RunReplaySpec, type EnvAttestationSummary } from "../core/reproducibility.js";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, describeManifest, validateBioManifest, type BioRegistry, type BioManifest, type ManifestDescription, type ResolutionReceipt } from "../core/manifest.js";
import { recordRunObservation, type RunObservation } from "./run-observations.js";
import { actionCachePut, actionInputDigest } from "./action-cache.js";
import type { CasStore } from "../core/cas.js";
import type { BioResolverImpl, ProcessRunner, SqlConn } from "../core/ports.js";
import { OperationRunError, runOperation, runQuery, type OperationResult } from "../core/operations.js";
import type { BioRunRecord } from "../core/run-spec.js";
import type { BioArtifact } from "../core/types.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { sqlReadsOnlyResolvedTables, resolvedBaseTables, sqlUsesNonDeterministicFn, hermeticIntrospectionUsable } from "../duckdb/plan-hermeticity.js";
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
  // A non-ARRAY `resources` (e.g. `{}`) must NOT TypeError here on `.map()` — this runs BEFORE registerManifest's
  // validation, so leave a malformed shape untouched and let validateBioManifest report it as a clean fail-closed
  // error (`provides.resources must be an array`), the same way bio_describe_model does.
  if (!Array.isArray(manifest.provides?.resources)) return manifest;
  const resources = manifest.provides.resources.map((res) => {
    if (!res || typeof res !== "object") return res; // non-object element — leave it for validateBioManifest to reject cleanly (don't TypeError here)
    if (!res.params || typeof res.params !== "object") return res; // missing/malformed params — validation rejects it; don't TypeError on res.params.command/.path
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

// ONE canonical run-id grammar, shared with core (run-spec) and job-store: leading alnum + [A-Za-z0-9._:-], max
// 128. Leading-alnum + no '/' means no path traversal; ':' is allowed for namespaced ids ('study:opentargets:001')
// and is filename-safe on the Linux/macOS targets. Keeping this in sync with run-spec/job-store is the invariant —
// a job/replay id accepted there MUST persist/execute/reproduce here.
const RUN_DIR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Ad-hoc SQL that pulls data NOT captured by a resolver receipt makes a run NON-HERMETIC, so it must not be memoized
// in the ActionCache (a hit could serve stale bytes). Broad + fail-closed: a false match only over-skips memoization
// (re-run), a miss over-memoizes (unsafe). The load-bearing clause is `\b(from|join)\s+(...|[\w$.]+\s*\()` — ANY
// TABLE FUNCTION invoked in FROM/JOIN position (read_csv_auto(, ST_Read(, parquet_scan(, and any future one) or a
// string-literal REPLACEMENT SCAN (`FROM 'data.csv'` auto-reads the file). This over-skips pure table functions
// (generate_series/range/unnest) too — safe. Plus inline named readers (read_*/`*_scan(` in a subquery/expr) and
// remote-URI literals. (A truly exotic ambient read not matching these is the residual heuristic risk; a plan-based
// proof would be the fully sound fix — the safe direction here is to prefer NOT memoizing.)
const AMBIENT_SQL_READ = /\b(from|join)\s+('|[\w$.]+\s*\()|\bread_\w+\s*\(|\b\w*_scan\s*\(|\b(glob|sniff_csv|parquet_metadata|parquet_schema)\s*\(|'(https?|s3|gs|gcs|az|azure|r2|hf|ftp):/i;

// VOLATILE / non-deterministic SQL functions: their output is NOT determined by the input CASID, so a run using one
// must not be memoized (a hit would serve a stale/wrong value). random/uuid/nextval etc. take (); now() too; the
// current_* / localtime* forms are keywords (no parens). Fail-closed like the ambient-read denylist.
const VOLATILE_SQL = /\b(random|uuid|gen_random_uuid|nextval|txid_current|now)\s*\(|\b(current_timestamp|current_date|current_time|localtimestamp|localtime)\b/i;

// Mark an error that occurred while OPENING the run's DuckDB db (create/connect) — BEFORE any resource resolution or
// process.compute side effect. A host that logs runs into a store can safely RETRY such a failure unlogged (e.g. the
// run db aliased the log store's file and lock-conflicted); a lock/error surfacing LATER may have already run side
// effects, so it must NOT be blindly retried. See the extension's withRunLog.
export function markRunDbOpenError<E>(err: E): E {
  if (err && typeof err === "object") (err as { __runDbOpen?: boolean }).__runDbOpen = true;
  return err;
}
export function isRunDbOpenError(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as { __runDbOpen?: boolean }).__runDbOpen === true);
}

// Bindings are persisted in replay.json (JSON) and re-read by reproduce()/recallRunResult to recompute the input
// CASID. A value that does NOT round-trip through JSON — a bigint (becomes number/string), NaN/Infinity (become
// null), undefined (dropped), a function/symbol, a non-plain object (Date etc.) — would make the re-read replay key
// DIFFER from the original run's, so recall misses or (worse) collides two distinct runs. Reject such bindings at the
// entry, before the run, so bindings are always JSON-round-trippable and the input key is stable across serialization.
function assertJsonSafeBindings(bindings: Record<string, unknown> | undefined): void {
  if (bindings === undefined) return;
  const check = (v: unknown, path: string): void => {
    if (v === null) return;
    const t = typeof v;
    if (t === "string" || t === "boolean") return;
    if (t === "number") { if (!Number.isFinite(v as number)) throw new Error(`binding '${path}' is a non-finite number (NaN/Infinity) — bindings must be JSON-serializable so they round-trip through replay.json`); return; }
    if (t === "bigint") throw new Error(`binding '${path}' is a bigint — bindings must be JSON-serializable (a bigint does not round-trip through replay.json, breaking reproduce/recall keys); pass it as a string`);
    if (t === "function" || t === "symbol" || t === "undefined") throw new Error(`binding '${path}' is a ${t} — bindings must be JSON-serializable values`);
    if (Array.isArray(v)) { v.forEach((e, i) => check(e, `${path}[${i}]`)); return; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`binding '${path}' is a non-plain object (${proto?.constructor?.name ?? "unknown"}) — bindings must be JSON-serializable`);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) check(val, `${path}.${k}`);
  };
  for (const [k, v] of Object.entries(bindings)) check(v, k);
}

/** Resolve a run's directory, refusing a runId that could escape runsRoot. Centralized so every persistence
 *  path (and the host runner) is path-safe, including the exported persist* helpers called directly. */
function runDir(cwd: string, runId: string): string {
  if (!RUN_DIR_ID_RE.test(runId)) throw new Error("runId must start with a letter/number and contain only [A-Za-z0-9._:-] (no path separators)");
  return join(runsRoot(cwd), runId);
}

export interface RunPayload {
  run: BioRunRecord;
  result: OperationResult;
  receipts: ResolutionReceipt[];
}

export interface PersistedRun {
  dir: string;
  // result/receipts are optional: in lean mode (serialize:false) their bytes live in CAS, not as files.
  files: { run: string; result?: string; receipts?: string };
}

// DuckDB returns BIGINT/HUGEINT (e.g. a bare `count(*)`) as a JS BigInt, which JSON.stringify cannot serialize.
// The result IS the report and must be JSON, so a naive `count(*) AS n` must persist without the user casting.
// LOSSLESS: a value within ±2^53 becomes a Number (bio counts/positions/frequencies live here — natural JSON);
// anything beyond becomes a decimal STRING rather than a silently-rounded Number, so a >2^53 id/HUGEINT is never
// corrupted (and the receipt digest stays faithful). Consumers read a number normally; a string flags "too big".
const MAX_SAFE = 9007199254740991n;
const bigintToJson = (_key: string, value: unknown): unknown =>
  typeof value !== "bigint" ? value : value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();

// In lean mode (serialize:false) result.json is NOT written — the result bytes live in CAS. Retarget the run
// record's output artifact from the (unwritten) `runs/<id>/result.json` path to its `cas:sha256:…` URI, so the
// always-written run.json never points at a file that does not exist. Only the file-persisted copy is retargeted;
// the ledger/run-object use the digest directly.
function retargetResultArtifactToCas(run: BioRunRecord, runId: string, casUri: string): BioRunRecord {
  const filePath = `runs/${runId}/result.json`;
  const fix = (a: BioArtifact): BioArtifact => (a.path === filePath ? { ...a, path: casUri } : a);
  return {
    ...run,
    artifacts: run.artifacts?.map(fix),
    events: run.events.map((e) => (e.artifacts?.length ? { ...e, artifacts: e.artifacts.map(fix) } : e)),
  };
}

async function writeRunFile(dir: string, name: string, data: unknown): Promise<string> {
  const path = join(dir, name);
  // ATOMIC write (temp + rename): a reader (or a reproduce that reads replay.json) never sees a PARTIAL JSON file,
  // and on a crash/ENOSPC mid-write the previous file is left intact rather than truncated — so a reused runId dir
  // can't end up with a fresh run.json paired with a half-written result.json.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmp, `${JSON.stringify(data, bigintToJson, 2)}\n`, "utf8");
  await fs.rename(tmp, path);
  return path;
}

/** Host-level persistence: write run(.json) under .pi/bio-agent/runs/<runId>/, plus — unless `serialize` is false
 *  — result.json (the report) and receipts.json (the provenance). In lean mode (serialize:false) only run.json is
 *  written; result/receipts bytes live in CAS by digest (referenced on the run:<id> fact), so the files are an
 *  OPTIONAL export. run.json is always written (small; the run-ledger example reads it). */
export async function persistRun(cwd: string, runId: string, payload: RunPayload, opts: { serialize?: boolean; casBacked?: boolean } = {}): Promise<PersistedRun> {
  // Lean mode DELETES result/receipts/replay files, so it is safe ONLY when their bytes already live in CAS. This
  // exported helper is a public footgun otherwise (a direct caller could drop provenance with no CAS), so require an
  // explicit casBacked assertion — runAndPersist sets it after its own serialize:false ⟹ cas guard.
  if (opts.serialize === false && !opts.casBacked) throw new Error("persistRun: serialize:false deletes result/receipts/replay files — pass casBacked:true only after writing those bytes to CAS, else the provenance is lost");
  const dir = runDir(cwd, runId);
  await fs.mkdir(dir, { recursive: true });
  // Each file write is atomic (temp+rename). On a runId REUSE the DIRECTORY isn't transactionally atomic — a crash
  // mid-persist can leave a mixed FILE view (new run.json beside a prior run's result), which is a VIEW issue: the
  // authoritative record is the run:<id> LEDGER fact (it references the actual result/receipts/replay by digest),
  // so a consumer reconciles from the ledger, not the files. WRITE-BEFORE-DELETE: write the new run's files first,
  // THEN clear stale files a prior run at this runId left — so a crash never DELETES the old evidence with nothing
  // new in its place (only overwrites, atomically).
  const files: PersistedRun["files"] = { run: await writeRunFile(dir, "run.json", payload.run) };
  if (opts.serialize !== false) {
    files.result = await writeRunFile(dir, "result.json", payload.result);
    files.receipts = await writeRunFile(dir, "receipts.json", payload.receipts);
  } else {
    // lean mode writes ONLY run.json (bytes live in CAS) — clear stale result/receipts/replay a prior SERIALIZED run
    // at this runId left, so a reader never sees a lean run beside stale files from a different run.
    await Promise.all([fs.rm(join(dir, "result.json"), { force: true }), fs.rm(join(dir, "receipts.json"), { force: true }), fs.rm(join(dir, "replay.json"), { force: true })]);
  }
  return { dir, files };
}

/** Persist a FAILED run: run.json (status "failed", carrying the error) + receipts.json for whatever resolved
 *  before the failure. No result.json — there is no answer. A failed run is still an auditable receipt. */
export async function persistFailedRun(cwd: string, runId: string, payload: { run: BioRunRecord; receipts: ResolutionReceipt[] }, opts: { serialize?: boolean; casBacked?: boolean } = {}): Promise<{ dir: string; files: { run: string; receipts?: string } }> {
  if (opts.serialize === false && !opts.casBacked) throw new Error("persistFailedRun: serialize:false deletes receipts/replay files — pass casBacked:true only after writing those bytes to CAS (see persistRun)");
  const dir = runDir(cwd, runId);
  await fs.mkdir(dir, { recursive: true });
  // WRITE-BEFORE-DELETE (see persistRun): write the failed run's files FIRST, then clear a stale result.json/
  // replay.json a PRIOR (successful) run at this runId left — so a reader never sees a failed run.json beside a
  // misleading success result, and a crash never destroys the prior evidence before the new record exists.
  const files: { run: string; receipts?: string } = { run: await writeRunFile(dir, "run.json", payload.run) };
  if (opts.serialize !== false) files.receipts = await writeRunFile(dir, "receipts.json", payload.receipts);
  await Promise.all([
    fs.rm(join(dir, "result.json"), { force: true }), // a FAILED run has NO result
    fs.rm(join(dir, "replay.json"), { force: true }),
    ...(opts.serialize === false ? [fs.rm(join(dir, "receipts.json"), { force: true })] : []), // lean writes none — clear a stale one
  ]);
  return { dir, files };
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
  /** Lean storage: when false, skip writing result/receipts/replay JSON files — their bytes go to CAS (needs a cas) and the run:<id> fact + casRefs reference them by digest; run.json is always written. Default true. */
  serialize?: boolean;
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

/** CAS content addresses for a run's immutable outputs — the bytes live in CAS (outside the DB), the fact + this
 *  response only reference them by digest. Present only when the host passed a CAS. */
export interface RunCasRefs {
  result?: string;
  receipts?: string;
  replay?: string;
  /** The run OBJECT (Data + Refs) content address — the single root digest of the whole run DAG. */
  runObject?: string;
}

export type RunOperationResponse =
  | { ok: true; runId: string; operationId: string; status: BioRunRecord["status"]; rowCount: number; artifacts: PersistedRun["files"]; casRefs?: RunCasRefs; runDir: string }
  | { ok: false; runId: string; operationId: string; status: BioRunRecord["status"]; error: string; casRefs?: RunCasRefs; runDir: string };

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
  // Build with ONLY DEFINED fields — never leave `undefined`-valued keys. The run-object INPUT CASID is hashed from
  // this in-memory `replay.process`, but replay.json (JSON.stringify) DROPS undefined keys, so an undefined-valued
  // key would make the digest recomputed from the recorded replay differ from the original — a process.compute run
  // object then isn't recomputable from its own replay (breaks reproduce/dedup). Omitting the keys keeps them equal.
  return {
    resourceId: r.id,
    ...(p.table !== undefined ? { table: p.table } : {}),
    ...(p.command !== undefined ? { command: p.command } : {}),
    ...(p.inputSql !== undefined ? { inputSql: p.inputSql } : {}),
    ...(p.resultTable !== undefined ? { resultTable: p.resultTable } : {}),
    ...(p.outputs !== undefined ? { outputs: p.outputs } : {}),
  };
}

/** The env attestation SUMMARY lifted from the receipts' `environment` provenance entry (process.compute records
 *  it as notes). Returns the FIRST process receipt that carries one — a deliberate walking-skeleton limit: today a
 *  run has at most ONE process.compute resource. LIMITATION (owed when multi-process runs ship): with two+ process
 *  resources this captures only the first, so reproduce()'s env-drift check would miss drift in a LATER resource's
 *  environment. The fix is a per-receipt env summary (keyed by resourceId) compared per resource; not built now
 *  because there is no multi-process consumer yet (building it would be speculative). Exported so
 *  reproduce() can recompute the RE-RUN's env summary and compare it to the pinned one (env lives in provenance
 *  NOTES, which receiptContentDigest drops — so without this check an env-drifted re-run would falsely 'match'). */
export function envSummaryFromReceipts(receipts: ReadonlyArray<{ provenance: ReadonlyArray<{ source: string; notes?: string[] }> }>): EnvAttestationSummary | undefined {
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
  args: { runId: string; identity: string; kind: "query" | "operation"; status: string; error: string | undefined; dir: string; replay?: RunReplaySpec; enriched?: RunReplaySpec; resultDigest?: string; receiptsDigest?: string; replayDigest?: string; runObjectDigest?: string },
): Promise<void> {
  if (!runLog) return;
  const obs: RunObservation = {
    runId: args.runId,
    kind: args.kind, // explicit from the caller (query vs operation) — NOT inferred from the identity string, since
                     // "ad-hoc.query" is a legal operation id and an identity sentinel would mislabel it.
    identity: args.identity,
    status: args.status,
    sql: args.replay?.sql,
    resources: args.replay?.resources,
    error: args.error,
    runDir: args.dir,
    manifestDigest: args.replay?.manifest?.digest,
    sourceReceiptDigests: args.enriched?.sourceReceiptDigests,
    resultDigest: args.resultDigest,
    receiptsDigest: args.receiptsDigest,
    replayDigest: args.replayDigest,
    runObjectDigest: args.runObjectDigest,
  };
  try {
    await recordRunObservation(runLog.store, obs, now, runLog.author);
  } catch {
    /* best-effort: never fail a run because the shared-ledger log failed */
  }
}

async function runAndPersist(
  cwd: string, dbPath: string, runId: string, identity: string, kind: "query" | "operation",
  body: (conn: SqlConn) => Promise<{ run: BioRunRecord; result: OperationResult; receipts: ResolutionReceipt[] }>,
  // The INJECTED clock (req.now) or undefined. Resolution/receipts use the caller's start-time `now` (captured in
  // `body`); the run:<id> ledger fact + ActionCache are stamped with a COMPLETION time (systemClock() at record time)
  // so a long run isn't visible as succeeded/failed BEFORE it finished. When `injectedNow` is set (deterministic
  // tests) both collapse to it, so test assertions on the timestamp are unchanged.
  injectedNow: string | undefined,
  initSql?: string[],
  bindings?: Record<string, unknown>,
  duckdbConfig?: Record<string, string>,
  replay?: RunReplaySpec,
  runLog?: { store: SqlConn; author?: string },
  cas?: CasStore,
  serialize?: boolean,
): Promise<RunOperationResponse> {
  // Fail closed: lean mode drops result/receipts/replay FILES, so without a CAS to hold those bytes they would be
  // lost entirely (data loss). Refuse rather than silently discard outputs/provenance.
  if (serialize === false && !cas) throw new Error("serialize:false requires a cas — refusing to skip result/receipts/replay files with nowhere else to store the bytes");
  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(resolveInCwd(cwd, dbPath), duckdbConfig);
  } catch (err) {
    throw markRunDbOpenError(err); // create() failed (bad db/config/lock) — BEFORE any resolution/compute side effect
  }
  let connection: Awaited<ReturnType<typeof instance.connect>>;
  try {
    connection = await instance.connect();
  } catch (err) {
    instance.closeSync(); // connect() failed (bad db/config/lock) — the finally below can't run yet, so close the instance here or it leaks (a process-exclusive writer lock would linger)
    throw markRunDbOpenError(err); // still BEFORE side effects — a host may retry unlogged (see extension withRunLog)
  }
  const conn = duckdbNodeConn(connection);
  // Put a JSON blob in CAS (bytes OUTSIDE the DB) and return its content address, or undefined when no CAS.
  const putCas = async (obj: unknown): Promise<string | undefined> => {
    if (!cas) return undefined;
    const bytes = Buffer.from(JSON.stringify(obj, bigintToJson), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await cas.put({ algorithm: "sha256", digest }, bytes); // immutable + idempotent
    return `sha256:${digest}`;
  };
  try {
    // Agent params are DuckDB SESSION VARIABLES: the agent's bindings become `SET VARIABLE name = value`, so a
    // resource url/body composes them with plain SQL (`'…?q=' || getvariable('query')`). Values are parameter-bound
    // (no injection). These go FIRST so host init below is AUTHORITATIVE: an agent binding must NOT be able to
    // override a host-owned session variable (e.g. re-point an `api_base`/`tls` the host provisioned) — host wins.
    if (bindings) for (const [name, value] of Object.entries(bindings)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`binding name '${name}' must be a SQL identifier`);
      await conn.run(`SET VARIABLE ${name} = ?`, [value as never]);
    }
    // Host-owned connection bootstrap: INSTALL/LOAD/SET (e.g. httpfs + cache_httpfs, an extension dir, a memory
    // limit) run ONCE on this connection before any resolution — AFTER agent bindings, so host values win on any
    // name clash. A failure here is a config/pre-flight error (thrown, not a failed run): the run never started.
    // SECRETS BOUNDARY: session variables set here live in the SAME session as agent-written SQL (bio_query), which
    // can read them with getvariable() — so a `SET VARIABLE token='…'` would be exfiltratable into result.json. Do
    // NOT put secrets in SET VARIABLE: use the fetch-layer auth (withAuth headers, never touch SQL) or DuckDB
    // `CREATE SECRET` (function-scoped, not getvariable-readable). SET VARIABLE is for NON-secret config only.
    if (initSql) for (const stmt of initSql) await conn.run(stmt);
    try {
      const { run, result, receipts } = await body(conn);
      let enriched = replay ? enrichReplay(replay, receipts) : undefined;
      // result rows -> CAS FIRST (needed to retarget the artifact below); the run:<id> fact references it by digest.
      const resultDigest = await putCas(result.rows);
      // PIN the result-content digest into the replay, so reproduce() can verify the OUTPUT matched, not just the
      // sources (only available when a CAS is present — otherwise reproduce falls back to receipt-only checking).
      if (enriched && resultDigest) enriched = { ...enriched, resultDigest };
      // CAS-write receipts/replay/runObject BEFORE persistRun. In lean mode persistRun DELETES the stale
      // receipts.json/replay.json (bytes are meant to live in CAS), so writing to CAS first closes a DATA-LOSS window:
      // a crash or a failed CAS write between the delete and the put would otherwise leave a lean run's provenance
      // bytes neither on disk nor in CAS. (In non-lean mode the bytes end up in both CAS and files — harmless.)
      const receiptsDigest = await putCas(receipts);
      const replayDigest = enriched ? await putCas(enriched) : undefined;
      // run-as-object-DAG (LLVM CASObject: Data + Refs): a single CAS object whose refs are the run's CONTENT-
      // equivalence roots — the INPUT CASID (actionInputDigest = manifest+SQL+resolved-source digests) and the
      // RESULT CASID. Its digest is the root by which two runs are compared/deduped: identical input+result -> one
      // runObjectDigest. Refs are CONTENT-only (no runId/timestamps) so dedup can happen at all; the run-specific
      // receipts/replay blob digests are carried SEPARATELY on the run:<id> fact, NOT under this root.
      const runObjectDigest = cas && enriched && resultDigest
        ? await putCas({ schema: "pi-bio.run_object.v1", data: { kind, identity, status: run.status }, refs: { input: actionInputDigest(enriched), result: resultDigest } })
        : undefined;
      // GC ROOT for lean mode, written BEFORE persistRun deletes stale JSON: the node-local collectGarbage roots CAS
      // by scanning surviving run files, but a lean run writes NO receipts.json — so cas-refs.json lists THIS run's
      // CAS digests. It MUST exist before persistRun clears the stale receipts.json/replay.json, or a crash in that
      // gap would leave the lean run's bytes in CAS but UNROOTED (GC-sweepable). persistRun does not touch
      // cas-refs.json, so writing it first is safe. (Runs are still also rooted by the run:<id> ledger fact when a
      // store is passed; this is the file-based root for the no-store case.)
      const dir = runDir(cwd, runId);
      await fs.mkdir(dir, { recursive: true });
      if (cas && (resultDigest || receiptsDigest || replayDigest || runObjectDigest)) {
        await writeRunFile(dir, "cas-refs.json", { schema: "pi-bio.cas_refs.v1", result: resultDigest, receipts: receiptsDigest, replay: replayDigest, runObject: runObjectDigest });
      } else {
        // RUNID REUSE: a prior CAS run at this same runId wrote a cas-refs.json; this run writes none (no cas), so
        // clear the stale one — else the node-local GC roots its dead digests (keeping swept-able bytes alive) and
        // the run dir advertises refs that don't belong to the current run.
        await fs.rm(join(dir, "cas-refs.json"), { force: true });
      }
      // Files are the legible VIEW (default). result.json/receipts.json/replay.json are skipped in lean mode
      // (serialize:false); run.json is always written — and in lean mode its output artifact points at the CAS URI,
      // not the unwritten result.json. (Safe: the CAS bytes are durable AND rooted by cas-refs.json before this deletes them.)
      const runForFiles = serialize === false && resultDigest ? retargetResultArtifactToCas(run, runId, `cas:${resultDigest}`) : run;
      const persisted = await persistRun(cwd, runId, { run: runForFiles, result, receipts }, { serialize, casBacked: cas !== undefined });
      if (enriched && serialize !== false) await writeRunFile(persisted.dir, "replay.json", enriched);
      // COMPLETION time (not run start): the ledger fact + memo record when the run FINISHED, so a long run isn't
      // visible as succeeded before it actually completed. Injected `now` (tests) collapses this to the fixed value.
      const completedAt = injectedNow ?? systemClock();
      // Datomic + CAS: record the run as a fact in the ONE store, referencing content by digest (bytes stay outside).
      await recordRun(runLog, completedAt, { runId, identity, kind, status: run.status, error: undefined, dir: persisted.dir, replay, enriched, resultDigest, receiptsDigest, replayDigest, runObjectDigest });
      // ActionCache (LLVM CAS): map this input's CASID -> the result's CASID, so an identical future run can be
      // memoized/deduped and reproduce() has an input->output handle. Only when both a CAS and the store are present.
      // SKIP a run with a LIVE SOURCE: its sourceReceiptDigests are blind to the source's CONTENT (sql_materialize /
      // remote read), so its input CASID does NOT determine the output — memoizing it would let recallRunResult serve
      // a STALE result when the live source changed underneath (the same class as reproduce's not_reproducible). Only
      // content-pinned runs get an input->output mapping that "a hit can never serve stale" actually holds for.
      const hasLiveSource = receipts.some((r) => r.provenance.some((p) => p.notes?.includes("live_source")));
      // HERMETICITY — proven by DuckDB's OWN analysis, no text heuristics. Two SOUND, un-evadable checks on the run
      // SQL: (1) sqlReadsOnlyResolvedTables walks the PHYSICAL PLAN — every data-source leaf must be a base-table scan
      // of a RESOLVED (receipt-pinned) table or a pure source, NEVER a table function / file reader / replacement scan
      // (comments/quotes/replacement scans all collapse to the same plan operators); (2) sqlUsesNonDeterministicFn
      // walks the parse-time AST (json_serialize_sql) + duckdb_functions.stability — no VOLATILE / CONSISTENT_WITHIN_
      // QUERY function (random()/now()/uuid()), which don't appear in the physical plan and vary across runs. Both
      // fail CLOSED. Also require :memory: (a file-backed db carries ambient tables no receipt pins) AND the host INIT
      // SQL has no ambient read / ATTACH / volatile (it isn't a single serializable query, so it keeps the text check).
      const runSql = enriched?.sql ?? "";
      const initUnproven = (initSql ?? []).some((s) => AMBIENT_SQL_READ.test(s) || VOLATILE_SQL.test(s) || /\/\*|--|"/.test(s) || /\battach\b/i.test(s));
      const hermetic =
        dbPath === ":memory:" &&
        !initUnproven &&
        runSql !== "" &&
        (await hermeticIntrospectionUsable(conn)) && // guard: if a DuckDB parser/plan-format change broke our introspection, memoization turns OFF (never a wrong memo)
        !(await sqlUsesNonDeterministicFn(conn, runSql)) &&
        (await sqlReadsOnlyResolvedTables(conn, runSql, await resolvedBaseTables(conn)));
      if (resultDigest && runLog && enriched && !hasLiveSource && hermetic) {
        try {
          // key on the ENRICHED replay so the action key is CONTENT-addressed (includes sourceReceiptDigests) —
          // a changed source yields a different key, so a future memoized hit can never serve a stale result.
          await actionCachePut(runLog.store, actionInputDigest(enriched), resultDigest, completedAt, runLog.author);
        } catch {
          /* best-effort memo: never fail a run because the action-cache write failed */
        }
      }
      const casRefs = cas ? { result: resultDigest, receipts: receiptsDigest, replay: replayDigest, runObject: runObjectDigest } : undefined;
      return { ok: true, runId, operationId: identity, status: run.status, rowCount: result.rows.length, artifacts: persisted.files, casRefs, runDir: persisted.dir };
    } catch (error) {
      // A run that started and failed at runtime persists a failed-run receipt and returns ok:false; the
      // failure is auditable, not lost. Pre-flight/config errors (which never became a run) still throw.
      if (error instanceof OperationRunError) {
        const enriched = replay ? enrichReplay(replay, error.receipts) : undefined;
        // SAME lean-mode data-loss fix as the success path: CAS-write the failed run's receipts/replay BEFORE
        // persistFailedRun deletes/skips the JSON files, so a crash/failed-put can't strand the provenance bytes.
        const receiptsDigest = await putCas(error.receipts);
        const replayDigest = enriched ? await putCas(enriched) : undefined;
        // Root the failed run's CAS bytes in cas-refs.json BEFORE persistFailedRun deletes stale JSON (same crash
        // window as the success path). persistFailedRun does not touch cas-refs.json, so writing it first is safe.
        const dir = runDir(cwd, runId);
        await fs.mkdir(dir, { recursive: true });
        if (cas && (receiptsDigest || replayDigest)) {
          await writeRunFile(dir, "cas-refs.json", { schema: "pi-bio.cas_refs.v1", receipts: receiptsDigest, replay: replayDigest });
        } else {
          await fs.rm(join(dir, "cas-refs.json"), { force: true }); // reused runId: clear a prior CAS run's stale cas-refs.json (see the success path)
        }
        const persisted = await persistFailedRun(cwd, runId, { run: error.run, receipts: error.receipts }, { serialize, casBacked: cas !== undefined });
        if (enriched && serialize !== false) await writeRunFile(persisted.dir, "replay.json", enriched); // a failed run is replayable too
        const failedAt = injectedNow ?? systemClock(); // FAILURE time, not run start (see the success path)
        await recordRun(runLog, failedAt, { runId, identity, kind, status: error.run.status, error: error.message, dir: persisted.dir, replay, enriched, receiptsDigest, replayDigest });
        const casRefs = cas ? { receipts: receiptsDigest, replay: replayDigest } : undefined;
        return { ok: false, runId, operationId: identity, status: error.run.status, error: error.message, casRefs, runDir: persisted.dir };
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
  if (req.runId !== undefined && !RUN_DIR_ID_RE.test(req.runId)) {
    throw new Error("runId must start with a letter/number and contain only [A-Za-z0-9._:-] (no path traversal)"); // SAME regex as persistRun -> fail BEFORE effects, not after
  }
  assertJsonSafeBindings(req.bindings); // bindings must round-trip through replay.json (see the helper) — fail before any effect
  const { registry, raw, manifest, manifestDigest } = await prepareRegistry(req);
  const op = registry.getOperation(req.operationId);
  if (!op) throw new Error(`operation '${req.operationId}' is not declared in the manifest`);
  if (op.transport !== "duckdb.sql" || !op.sql) throw new Error(`operation '${req.operationId}' is not a duckdb.sql operation`);
  const now = req.now ?? systemClock();
  // A HIGH-ENTROPY suffix, not just Date.now(): `run:<runId>` is the ledger statement_key, and in a SHARED store
  // (across projects/agents) a bare timestamp collides -> two unrelated runs would conflate into one as-of slot.
  const runId = req.runId ?? `${req.operationId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  // Scope process facts to the resources the operation ACTUALLY resolves (its declared requiredResources) — NOT
  // every resource the manifest happens to declare. Otherwise replay.json would record an unrelated process.compute
  // resource's command as "what ran" even though runOperation never resolved it (a provenance lie).
  const requiredResources = op.sql.requiredResources ?? [];
  const proc = resolvedProcessFacts(manifest, requiredResources);
  const replay: RunReplaySpec = {
    schema: RUN_REPLAY_SPEC_SCHEMA, runId, kind: "operation",
    manifest: { digest: manifestDigest, snapshot: raw, path: req.manifestPath },
    operationId: req.operationId, sql: op.sql.sqlTemplate,
    ...(req.bindings ? { bindings: req.bindings } : {}), ...(req.duckdbInitSql ? { duckdbInitSqlDigest: canonicalDigest(req.duckdbInitSql) } : {}), // pin WHICH init SQL (digest, not the possibly-secret-bearing SQL itself)
    ...(req.duckdbConfig ? { duckdbConfigDigest: canonicalDigest(req.duckdbConfig) } : {}), // pin WHICH config (digest, not the secret-bearing config itself)
    ...(proc ? { process: proc } : {}),
  };
  return runAndPersist(req.cwd, req.dbPath, runId, req.operationId, "operation", (conn) => runOperation(registry, conn, { operationId: req.operationId, runId, now, signal: req.signal, cas: req.cas }), req.now, req.duckdbInitSql, req.bindings, req.duckdbConfig, replay, req.store ? { store: req.store, author: req.author } : undefined, req.cas, req.serialize);
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
  /** Lean storage: when false, skip writing result/receipts/replay JSON files — their bytes go to CAS (needs a cas) and the run:<id> fact + casRefs reference them by digest; run.json is always written. Default true. */
  serialize?: boolean;
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
  if (req.runId !== undefined && !RUN_DIR_ID_RE.test(req.runId)) {
    throw new Error("runId must start with a letter/number and contain only [A-Za-z0-9._:-] (no path traversal)"); // SAME regex as persistRun -> fail BEFORE effects, not after
  }
  assertJsonSafeBindings(req.bindings); // bindings must round-trip through replay.json (see the helper) — fail before any effect
  const { registry, manifest, raw, manifestDigest } = await prepareRegistry(req);
  const resources = req.resources ?? (manifest.provides?.resources ?? []).map((r) => r.id);
  const now = req.now ?? systemClock();
  const runId = req.runId ?? `query-${Date.now()}-${randomUUID().slice(0, 8)}`; // globally unique: see runBioOperationFromManifest
  const proc = resolvedProcessFacts(manifest, resources);
  const replay: RunReplaySpec = {
    schema: RUN_REPLAY_SPEC_SCHEMA, runId, kind: "query",
    manifest: { digest: manifestDigest, snapshot: raw, path: req.manifestPath },
    sql: req.sql, resources,
    ...(req.bindings ? { bindings: req.bindings } : {}), ...(req.duckdbInitSql ? { duckdbInitSqlDigest: canonicalDigest(req.duckdbInitSql) } : {}), // pin WHICH init SQL (digest, not the possibly-secret-bearing SQL itself)
    ...(req.duckdbConfig ? { duckdbConfigDigest: canonicalDigest(req.duckdbConfig) } : {}), // pin WHICH config (digest, not the secret-bearing config itself)
    ...(proc ? { process: proc } : {}),
  };
  return runAndPersist(req.cwd, req.dbPath, runId, "ad-hoc.query", "query", (conn) => runQuery(registry, conn, { sql: req.sql, resources, runId, now, signal: req.signal, cas: req.cas }), req.now, req.duckdbInitSql, req.bindings, req.duckdbConfig, replay, req.store ? { store: req.store, author: req.author } : undefined, req.cas, req.serialize);
}
