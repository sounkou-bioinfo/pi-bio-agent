import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
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

async function producedDigests(runDir: string): Promise<string[]> {
  const receipts = JSON.parse(await fs.readFile(join(runDir, "receipts.json"), "utf8")) as Parameters<typeof receiptContentDigest>[0][];
  return receipts.map((r) => receiptContentDigest(r));
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
    const currentText = await fs.readFile(replay.manifest!.path!, "utf8");
    const currentDigest = `sha256:${createHash("sha256").update(currentText).digest("hex")}`;
    if (currentDigest !== replay.manifest!.digest) throw new Error(`reproduce: manifest at ${replay.manifest!.path} has CHANGED since the run (${currentDigest} != pinned ${replay.manifest!.digest}) — reproduction would run different logic (fail closed)`);
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

  const produced = await producedDigests(res.runDir);
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
  return {
    runId: replay.runId, kind: replay.kind, reproduced: true,
    matched: receiptsMatched && (resultMatched ?? true), // BOTH provenance and (when pinned) output content must match
    expected, produced, missing, extra, resultMatched, expectedResultDigest, producedResultDigest, runDir: res.runDir,
  };
}
