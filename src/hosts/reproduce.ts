import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { RUN_REPLAY_SPEC_SCHEMA, receiptContentDigest, canonicalDigest, hostCapabilityReceiptDigests, type EnvAttestationSummary, type HostCapabilityReceipt, type RunReplayOutcome, type RunReplaySpec } from "../core/reproducibility.js";
import type { CasStore } from "../core/cas.js";
import type { ComputeRunner, SqlConn } from "../core/ports.js";
import type { FetchLike } from "../duckdb/resolvers/http-table-scan.js";
import { runBioOperationFromManifest, runBioQueryFromManifest, computeEnvironmentSummariesFromReceipts, type RunOperationResponse } from "./run-store.js";

// C2 — reproduce(). Given a RunReplaySpec (the durable replay inputs L1's job carries), re-execute it against a
// FRESH db and compare the produced receipts' DETERMINISTIC content digests to the spec's sourceReceiptDigests.
// A faithful re-run of the same inputs yields the same content digests (receiptContentDigest excludes wall-clock),
// so a mismatch is REAL drift — a changed resolver, params, source version, or resolved result — not a clock diff.
// Fail closed: a replay without a manifest or without pinned sourceReceiptDigests cannot be verified, so it throws
// rather than reporting a hollow "match". (Portable snapshot->temp-manifest staging and compute.run env
// re-pinning are later refinements; this slice reproduces same-host query/operation runs.)
//
// PATH-PORTABILITY LIMITATION (fails SAFE): a file-backed resource's paramsDigest includes the ABSOLUTE path that
// resolveResourcePaths derived (resolve(manifestDir, "./x")), so the SAME manifest+content checked out at a
// DIFFERENT absolute path (CI /tmp/repo vs dev /home/a/repo) produces DIFFERENT sourceReceiptDigests. Cross-checkout
// reproduce therefore reports DRIFT (matched:false) and the cross-machine action-cache MISSES — a false NEGATIVE,
// never a false match/stale serve. Same-checkout reproduce (the supported slice) is unaffected. Making the
// per-resource digest path-independent (digest the authored relative form) is a deliberate later refinement; the
// portable AUTHORED manifest is already pinned via replay.manifest.digest, and a CAS resultDigest still verifies
// OUTPUT content regardless of path.

export interface ReproduceResult {
  runId: string;
  /** Run id of the fresh verification execution. */
  reproductionRunId?: string;
  kind: RunReplaySpec["kind"];
  /** The fresh execution reached the same terminal status/error identity. An expected failure can reproduce. */
  reproduced: boolean;
  /** Terminal outcome, receipts, environments, and any pinned result content all matched. */
  matched: boolean;
  expected: string[];
  produced: string[];
  /** expected but not produced, and produced but not expected — the concrete drift. */
  missing: string[];
  extra: string[];
  /** OUTPUT-content check: the re-run's result CAS digest vs the pinned one. undefined = not pinned/not checkable. */
  resultMatched?: boolean;
  expectedResultDigest?: string;
  producedResultDigest?: string;
  /** Per-resource environment check. Provenance notes are outside receiptContentDigest, so this is an independent
   *  replay condition. undefined means neither run used compute. */
  environmentMatched?: boolean;
  environmentComparisons?: Array<{
    resourceId: string;
    expected: EnvAttestationSummary[];
    produced: EnvAttestationSummary[];
    matched: boolean;
  }>;
  outcomeMatched: boolean;
  expectedOutcome: RunReplayOutcome;
  producedOutcome: RunReplayOutcome;
  /** Set (with a reason) when the run CANNOT be honestly verified — an un-snapshotted live source and no output
   *  content pin. The roadmap's third C2 outcome: not_reproducible, never fake confidence. `matched` is false. */
  notReproducible?: string;
  runDir?: string;
  error?: string;
}

export interface ReproduceRequest {
  cwd: string;
  replay: RunReplaySpec;
  /** always a fresh db (default :memory:) — reproduce must not read a prior run's state. */
  dbPath?: string;
  network?: { fetch: FetchLike };
  compute?: { runner: ComputeRunner };
  /** Host cancellation for network resolution, compute, and result materialization during the fresh run. */
  signal?: AbortSignal;
  cas?: CasStore;
  /** Host-owned cross-db remote-cache isolation scope for the re-run. Not stored in replay; receipts/content
   *  still decide whether reproduction matched. */
  remoteCacheScope?: string;
  /** the host re-supplies the DuckDB config (it may bear secrets, so it is NOT stored in the replay — only its
   *  digest is). reproduce re-applies it and verifies it matches the pinned `duckdbConfigDigest`, failing closed. */
  duckdbConfig?: Record<string, string>;
  /** the host re-supplies the connection-init SQL (it may bear secrets, so it is NOT stored in the replay — only
   *  its digest is). reproduce re-applies it and verifies it matches the pinned `duckdbInitSqlDigest`, failing closed. */
  duckdbInitSql?: string[];
  /** Host-owned protected session bindings. Values are not stored in replay; a pinned digest must be re-supplied. */
  protectedSessionBindings?: Record<string, unknown>;
  /** Additional host-declared protected session variable names, e.g. for variables set by duckdbInitSql. */
  protectedSessionVariables?: string[];
  /** Secret-free host capability policy receipts pinned by the original run, e.g. ducknng HTTP profile receipts. */
  hostCapabilityReceipts?: readonly HostCapabilityReceipt[];
  /** Optional required evidence sink for the fresh verification run. */
  store?: SqlConn;
  author?: string;
  now?: string;
}

function assertReproducible(replay: RunReplaySpec): void {
  if (!replay || replay.schema !== RUN_REPLAY_SPEC_SCHEMA) throw new Error("reproduce: not a valid RunReplaySpec (fail closed)");
  if (!replay.manifest?.path && !replay.manifest?.snapshot) throw new Error("reproduce: replay has no manifest to re-run (fail closed)");
  if (!replay.manifest?.path) throw new Error("reproduce: this slice re-runs from replay.manifest.path (same-host); a snapshot-only replay is not yet supported");
  if (!replay.outcome) throw new Error("reproduce: replay has no terminal outcome pin (fail closed)");
  if (!["succeeded", "failed", "cancelled"].includes(replay.outcome.status)) throw new Error("reproduce: replay has an invalid terminal outcome status (fail closed)");
  if (replay.outcome.status === "succeeded" && replay.outcome.errorDigest !== undefined) {
    throw new Error("reproduce: succeeded replay must not carry an errorDigest (fail closed)");
  }
  if (replay.outcome.status !== "succeeded" && !/^sha256:[0-9a-f]{64}$/.test(replay.outcome.errorDigest ?? "")) {
    throw new Error(`reproduce: ${replay.outcome.status} replay has no valid errorDigest (fail closed)`);
  }
  // Verify against SOMETHING: pinned source receipts (provenance), output content, or an expected terminal failure. A
  // resource-free run (e.g. `SELECT 1`) legitimately has zero receipts but IS reproducible via its resultDigest —
  // only refuse a truly hollow replay that pins neither (a vacuous 'match' is worse than an honest refusal).
  const hasReceiptPins = Array.isArray(replay.sourceReceiptDigests) && replay.sourceReceiptDigests.length > 0;
  const hasFailurePin = replay.outcome.status !== "succeeded" && replay.outcome.errorDigest !== undefined;
  if (!hasReceiptPins && !replay.resultDigest && !hasFailurePin) {
    throw new Error("reproduce: replay pins neither sourceReceiptDigests, a resultDigest, nor a terminal failure to verify against (fail closed). A successful resource-free run must carry a resultDigest — run it with a CAS so the output content is pinned.");
  }
  if (replay.computeResources) {
    const ids = new Set<string>();
    for (const resource of replay.computeResources) {
      if (!resource.resourceId || ids.has(resource.resourceId)) throw new Error("reproduce: computeResources must have unique non-empty resourceId values (fail closed)");
      ids.add(resource.resourceId);
    }
  }
}

function compareComputeEnvironments(
  replay: RunReplaySpec,
  receipts: ReadonlyArray<{ resourceId: string; provenance: ReadonlyArray<{ source: string; notes?: string[] }> }>,
): Pick<ReproduceResult, "environmentMatched" | "environmentComparisons"> {
  const expected = new Map<string, EnvAttestationSummary[]>();
  for (const resource of replay.computeResources ?? []) {
    if (resource.environment) expected.set(resource.resourceId, [resource.environment]);
  }
  const produced = new Map<string, EnvAttestationSummary[]>();
  for (const entry of computeEnvironmentSummariesFromReceipts(receipts)) {
    produced.set(entry.resourceId, [...(produced.get(entry.resourceId) ?? []), entry.environment]);
  }
  if (expected.size === 0 && produced.size === 0) return {};
  const resourceIds = [...new Set([...expected.keys(), ...produced.keys()])].sort();
  const environmentComparisons = resourceIds.map((resourceId) => {
    const expectedForResource = expected.get(resourceId) ?? [];
    const producedForResource = produced.get(resourceId) ?? [];
    return {
      resourceId,
      expected: expectedForResource,
      produced: producedForResource,
      matched: canonicalDigest(expectedForResource) === canonicalDigest(producedForResource),
    };
  });
  return { environmentMatched: environmentComparisons.every((entry) => entry.matched), environmentComparisons };
}

function normalizeProtectedSessionVariables(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.toLowerCase()))].sort();
}

export async function reproduceRun(req: ReproduceRequest): Promise<ReproduceResult> {
  const replay = req.replay;
  assertReproducible(replay);
  // DuckDB config affects results but bears secrets, so the replay pins only its DIGEST. To reproduce faithfully the
  // host must re-supply the SAME config: require it and verify its digest matches, or refuse (a run under a
  // different/absent config is not a faithful reproduction).
  if (replay.duckdbConfigDigest) {
    if (!req.duckdbConfig) throw new Error("reproduce: this run pinned a duckdbConfigDigest — re-supply the same duckdbConfig to reproduce it faithfully (fail closed)");
    if (canonicalDigest(req.duckdbConfig) !== replay.duckdbConfigDigest) throw new Error("reproduce: the supplied duckdbConfig does not match the pinned duckdbConfigDigest (would not be a faithful reproduction)");
  }
  // Same for connection-init SQL: the replay pins only its DIGEST (it can carry secrets), so the host must re-supply
  // the SAME init SQL and we verify the digest — else refuse (fail closed).
  if (replay.duckdbInitSqlDigest) {
    if (!req.duckdbInitSql) throw new Error("reproduce: this run pinned a duckdbInitSqlDigest — re-supply the same duckdbInitSql to reproduce it faithfully (fail closed)");
    if (canonicalDigest(req.duckdbInitSql) !== replay.duckdbInitSqlDigest) throw new Error("reproduce: the supplied duckdbInitSql does not match the pinned duckdbInitSqlDigest (would not be a faithful reproduction)");
  }
  if (replay.protectedSessionBindingsDigest) {
    if (!req.protectedSessionBindings) throw new Error("reproduce: this run pinned a protectedSessionBindingsDigest — re-supply the same protectedSessionBindings to reproduce it faithfully (fail closed)");
    if (canonicalDigest(req.protectedSessionBindings) !== replay.protectedSessionBindingsDigest) throw new Error("reproduce: the supplied protectedSessionBindings do not match the pinned protectedSessionBindingsDigest (would not be a faithful reproduction)");
  }
  if (replay.protectedSessionVariablesDigest) {
    if (!req.protectedSessionVariables) throw new Error("reproduce: this run pinned a protectedSessionVariablesDigest — re-supply the same protectedSessionVariables to reproduce it faithfully (fail closed)");
    if (canonicalDigest(normalizeProtectedSessionVariables(req.protectedSessionVariables)) !== replay.protectedSessionVariablesDigest) throw new Error("reproduce: the supplied protectedSessionVariables do not match the pinned protectedSessionVariablesDigest (would not be a faithful reproduction)");
  }
  if (replay.hostReceiptDigests?.length) {
    const supplied = hostCapabilityReceiptDigests(req.hostCapabilityReceipts);
    if (supplied.length === 0) throw new Error("reproduce: this run pinned hostReceiptDigests — re-supply the same hostCapabilityReceipts to reproduce it faithfully (fail closed)");
    if (JSON.stringify(supplied) !== JSON.stringify(replay.hostReceiptDigests)) throw new Error("reproduce: the supplied hostCapabilityReceipts do not match the pinned hostReceiptDigests (would not be a faithful reproduction)");
  }
  // VERIFY the manifest hasn't changed: reproduce re-runs from replay.manifest.path (by operationId or sql), so a
  // manifest edited since the original run would execute DIFFERENT logic yet could still 'match' if receipts happen
  // to align. Compare the CURRENT file's digest to the pinned one and fail closed on drift. (manifestDigest =
  // sha256 of the file text, matching prepareRegistry.)
  if (replay.manifest!.digest) {
    // Resolve the (possibly-relative) manifest path against req.cwd — the SAME base the re-run uses
    // (prepareRegistry: resolveInCwd(req.cwd, path)). Reading it against the process cwd would verify the digest of
    // a DIFFERENT (or missing) file than the one actually re-run, making same-host replay cwd-sensitive.
    const manifestFile = isAbsolute(replay.manifest!.path!) ? replay.manifest!.path! : resolve(req.cwd, replay.manifest!.path!);
    const currentText = await fs.readFile(manifestFile, "utf8");
    const currentDigest = `sha256:${createHash("sha256").update(currentText).digest("hex")}`;
    if (currentDigest !== replay.manifest!.digest) throw new Error(`reproduce: manifest at ${manifestFile} has CHANGED since the run (${currentDigest} != pinned ${replay.manifest!.digest}) — reproduction would run different logic (fail closed)`);
  }
  // The reproduction run id must stay within the run-dir id limit (128 chars, RUN_DIR_ID_RE) — otherwise an ORIGINAL
  // runId near that max would, with the `reproduce-…-<epoch>` wrapping, overflow and be rejected before reproduction,
  // making a valid persisted run unreproducible. Truncate the original portion to fit (it's an internal temp-run id;
  // full fidelity isn't needed — the epoch suffix keeps it unique).
  const suffix = `-${Date.now()}`;
  const budget = 128 - "reproduce-".length - suffix.length;
  const shortId = replay.runId.slice(0, Math.max(1, budget));
  const base = {
    cwd: req.cwd, dbPath: req.dbPath ?? ":memory:", manifestPath: replay.manifest!.path!,
    bindings: replay.bindings, duckdbInitSql: req.duckdbInitSql, protectedSessionBindings: req.protectedSessionBindings, protectedSessionVariables: req.protectedSessionVariables, duckdbConfig: req.duckdbConfig, hostCapabilityReceipts: req.hostCapabilityReceipts,
    network: req.network, compute: req.compute, signal: req.signal, cas: req.cas, remoteCacheScope: req.remoteCacheScope,
    store: req.store, author: req.author,
    runId: `reproduce-${shortId}${suffix}`, now: req.now,
  };

  let res: RunOperationResponse;
  // dispatch on the actual replay payload (robust regardless of the kind label): an operationId => a declared op;
  // otherwise the ad-hoc SQL path.
  if (replay.operationId) res = await runBioOperationFromManifest({ ...base, operationId: replay.operationId });
  else if (replay.sql) res = await runBioQueryFromManifest({ ...base, sql: replay.sql, resources: replay.resources });
  else throw new Error("reproduce: replay carries neither an operationId nor sql (nothing to re-run)");

  const receipts = JSON.parse(await fs.readFile(join(res.runDir, "receipts.json"), "utf8")) as (Omit<Parameters<typeof receiptContentDigest>[0], "provenance"> & { provenance: Array<{ source: string; digest?: string; notes?: string[] }> })[];
  const produced: string[] = receipts.map((r) => receiptContentDigest(r));
  const producedOutcome: RunReplayOutcome = res.ok
    ? { status: "succeeded" }
    : { status: res.status === "cancelled" ? "cancelled" : "failed", errorDigest: canonicalDigest(res.error) };
  const expectedOutcome = replay.outcome!;
  const outcomeMatched = canonicalDigest(producedOutcome) === canonicalDigest(expectedOutcome);
  // An un-snapshotted LIVE source is declared BY THE RESOLVER (which alone knows whether it captured content): a
  // `live_source` provenance note. duckdb.sql_materialize (reads arbitrary SQL/read_csv_auto — can't cheaply digest
  // its inputs) always sets it; file_scan sets it only for a remote/unreadable path (no content digest). A receipt
  // WITHOUT the note is content-pinned (file_scan stamps the file's content digest as the snapshot version), so a
  // changed source is honest drift — but a live-source receipt digest is blind to the source's CONTENT.
  const hasLiveSource = receipts.some((r) => (r.provenance ?? []).some((p) => p.notes?.includes("live_source")));
  const expected = replay.sourceReceiptDigests ?? [];
  const producedSet = new Set(produced);
  const expectedSet = new Set(expected);
  const missing = expected.filter((d) => !producedSet.has(d));
  const extra = produced.filter((d) => !expectedSet.has(d));
  const receiptsMatched = missing.length === 0 && extra.length === 0;
  // OUTPUT content: compare the re-run's result CAS digest to the pinned one. This is what makes "re-run matches by
  // content" TRUE for the actual output — a re-run with identical inputs but a different result is caught here.
  const expectedResultDigest = replay.resultDigest;
  const producedResultDigest = res.casRefs?.result;
  let resultMatched: boolean | undefined;
  if (expectedResultDigest) {
    if (res.ok && !producedResultDigest) throw new Error("reproduce: replay pins a resultDigest but the re-run produced none — pass a `cas` so the result content can be verified (fail closed)");
    resultMatched = producedResultDigest === expectedResultDigest;
  }
  // Each compute resource must reproduce its own attestation. Checking only one global digest lets drift in a later
  // resource falsely match when outputs happen to stay identical.
  const { environmentMatched, environmentComparisons } = compareComputeEnvironments(replay, receipts);
  // Roadmap C2 — never fake confidence: if the ONLY basis is receipts (no CAS resultDigest to verify OUTPUT content)
  // AND any source is un-snapshotted/live, the receipt match doesn't prove the output is the same (data.csv could
  // have changed underneath). That is not_reproducible, not a match.
  if (expectedResultDigest === undefined && hasLiveSource) {
    return {
      runId: replay.runId, reproductionRunId: res.runId, kind: replay.kind, reproduced: outcomeMatched, matched: false,
      expected, produced, missing, extra, environmentMatched, environmentComparisons,
      outcomeMatched, expectedOutcome, producedOutcome, runDir: res.runDir, ...(!res.ok ? { error: res.error } : {}),
      notReproducible: "an un-snapshotted live source (a sourceSnapshot with no version, e.g. duckdb.sql_materialize over read_csv_auto) is not content-verified and no resultDigest pins the output — re-run with a `cas` to pin output content",
    };
  }
  return {
    runId: replay.runId, reproductionRunId: res.runId, kind: replay.kind, reproduced: outcomeMatched,
    matched: outcomeMatched && receiptsMatched && (resultMatched ?? true) && (environmentMatched ?? true),
    expected, produced, missing, extra, resultMatched, expectedResultDigest, producedResultDigest,
    environmentMatched, environmentComparisons, outcomeMatched, expectedOutcome, producedOutcome,
    runDir: res.runDir, ...(!res.ok ? { error: res.error } : {}),
  };
}
