import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, isAbsolute } from "node:path";
import { RUN_REPLAY_SPEC_SCHEMA, receiptContentDigest, canonicalDigest, type RunReplaySpec } from "../core/reproducibility.js";
import type { CasStore } from "../core/cas.js";
import type { ProcessRunner } from "../core/ports.js";
import type { FetchLike } from "../duckdb/resolvers/http-table-scan.js";
import { runBioOperationFromManifest, runBioQueryFromManifest, type RunOperationResponse } from "./run-store.js";

// C2 — reproduce(). Given a RunReplaySpec (the durable replay inputs L1's job carries), re-execute it against a
// FRESH db and compare the produced receipts' DETERMINISTIC content digests to the spec's sourceReceiptDigests.
// A faithful re-run of the same inputs yields the same content digests (receiptContentDigest excludes wall-clock),
// so a mismatch is REAL drift — a changed resolver, params, source version, or resolved result — not a clock diff.
// Fail closed: a replay without a manifest or without pinned sourceReceiptDigests cannot be verified, so it throws
// rather than reporting a hollow "match". (Portable snapshot->temp-manifest staging and process.compute env
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
  kind: RunReplaySpec["kind"];
  /** the re-run completed without a run-level failure. */
  reproduced: boolean;
  /** receipts AND (if pinned) the result content matched. Only meaningful when `reproduced`. */
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
  process?: { runner: ProcessRunner };
  cas?: CasStore;
  /** the host re-supplies the DuckDB config (it may bear secrets, so it is NOT stored in the replay — only its
   *  digest is). reproduce re-applies it and verifies it matches the pinned `duckdbConfigDigest`, failing closed. */
  duckdbConfig?: Record<string, string>;
  /** the host re-supplies the connection-init SQL (it may bear secrets, so it is NOT stored in the replay — only
   *  its digest is). reproduce re-applies it and verifies it matches the pinned `duckdbInitSqlDigest`, failing closed. */
  duckdbInitSql?: string[];
  now?: string;
}

function assertReproducible(replay: RunReplaySpec): void {
  if (!replay || replay.schema !== RUN_REPLAY_SPEC_SCHEMA) throw new Error("reproduce: not a valid RunReplaySpec (fail closed)");
  if (!replay.manifest?.path && !replay.manifest?.snapshot) throw new Error("reproduce: replay has no manifest to re-run (fail closed)");
  if (!replay.manifest?.path) throw new Error("reproduce: this slice re-runs from replay.manifest.path (same-host); a snapshot-only replay is not yet supported");
  // Verify against SOMETHING: pinned source receipts (provenance) OR a pinned result digest (output content). A
  // resource-free run (e.g. `SELECT 1`) legitimately has zero receipts but IS reproducible via its resultDigest —
  // only refuse a truly hollow replay that pins neither (a vacuous 'match' is worse than an honest refusal).
  const hasReceiptPins = Array.isArray(replay.sourceReceiptDigests) && replay.sourceReceiptDigests.length > 0;
  if (!hasReceiptPins && !replay.resultDigest) {
    throw new Error("reproduce: replay pins neither sourceReceiptDigests nor a resultDigest to verify against (fail closed). A resource-free run must carry a resultDigest — run it with a CAS so the output content is pinned.");
  }
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
  const base = {
    cwd: req.cwd, dbPath: req.dbPath ?? ":memory:", manifestPath: replay.manifest!.path!,
    bindings: replay.bindings, duckdbInitSql: req.duckdbInitSql, duckdbConfig: req.duckdbConfig,
    network: req.network, process: req.process, cas: req.cas,
    runId: `reproduce-${replay.runId}-${Date.now()}`, now: req.now,
  };

  let res: RunOperationResponse;
  // dispatch on the actual replay payload (robust regardless of the kind label): an operationId => a declared op;
  // otherwise the ad-hoc SQL path.
  if (replay.operationId) res = await runBioOperationFromManifest({ ...base, operationId: replay.operationId });
  else if (replay.sql) res = await runBioQueryFromManifest({ ...base, sql: replay.sql, resources: replay.resources });
  else throw new Error("reproduce: replay carries neither an operationId nor sql (nothing to re-run)");

  if (!res.ok) { const exp = replay.sourceReceiptDigests ?? []; return { runId: replay.runId, kind: replay.kind, reproduced: false, matched: false, expected: exp, produced: [], missing: exp, extra: [], runDir: res.runDir, error: res.error }; }

  const receipts = JSON.parse(await fs.readFile(join(res.runDir, "receipts.json"), "utf8")) as (Omit<Parameters<typeof receiptContentDigest>[0], "provenance"> & { provenance: Array<{ source: string; digest?: string; notes?: string[] }> })[];
  const produced: string[] = receipts.map((r) => receiptContentDigest(r));
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
    if (!producedResultDigest) throw new Error("reproduce: replay pins a resultDigest but the re-run produced none — pass a `cas` so the result content can be verified (fail closed)");
    resultMatched = producedResultDigest === expectedResultDigest;
  }
  // Roadmap C2 — never fake confidence: if the ONLY basis is receipts (no CAS resultDigest to verify OUTPUT content)
  // AND any source is un-snapshotted/live, the receipt match doesn't prove the output is the same (data.csv could
  // have changed underneath). That is not_reproducible, not a match.
  if (expectedResultDigest === undefined && hasLiveSource) {
    return {
      runId: replay.runId, kind: replay.kind, reproduced: true, matched: false,
      expected, produced, missing, extra, runDir: res.runDir,
      notReproducible: "an un-snapshotted live source (a sourceSnapshot with no version, e.g. duckdb.sql_materialize over read_csv_auto) is not content-verified and no resultDigest pins the output — re-run with a `cas` to pin output content",
    };
  }
  return {
    runId: replay.runId, kind: replay.kind, reproduced: true,
    matched: receiptsMatched && (resultMatched ?? true), // BOTH provenance and (when pinned) output content must match
    expected, produced, missing, extra, resultMatched, expectedResultDigest, producedResultDigest, runDir: res.runDir,
  };
}
