import { promises as fs } from "node:fs";
import { join } from "node:path";
import { RUN_REPLAY_SPEC_SCHEMA, receiptContentDigest, type RunReplaySpec } from "../core/reproducibility.js";
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
  /** produced content digests == expected (as a set). Only meaningful when `reproduced`. */
  matched: boolean;
  expected: string[];
  produced: string[];
  /** expected but not produced, and produced but not expected — the concrete drift. */
  missing: string[];
  extra: string[];
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
  now?: string;
}

function assertReproducible(replay: RunReplaySpec): void {
  if (!replay || replay.schema !== RUN_REPLAY_SPEC_SCHEMA) throw new Error("reproduce: not a valid RunReplaySpec (fail closed)");
  if (!replay.manifest?.path && !replay.manifest?.snapshot) throw new Error("reproduce: replay has no manifest to re-run (fail closed)");
  if (!replay.manifest?.path) throw new Error("reproduce: this slice re-runs from replay.manifest.path (same-host); a snapshot-only replay is not yet supported");
  if (!Array.isArray(replay.sourceReceiptDigests) || replay.sourceReceiptDigests.length === 0) {
    throw new Error("reproduce: replay has no pinned sourceReceiptDigests to verify against (fail closed — a hollow 'match' is worse than an honest refusal)");
  }
}

async function producedDigests(runDir: string): Promise<string[]> {
  const receipts = JSON.parse(await fs.readFile(join(runDir, "receipts.json"), "utf8")) as Parameters<typeof receiptContentDigest>[0][];
  return receipts.map((r) => receiptContentDigest(r));
}

export async function reproduceRun(req: ReproduceRequest): Promise<ReproduceResult> {
  const replay = req.replay;
  assertReproducible(replay);
  const base = {
    cwd: req.cwd, dbPath: req.dbPath ?? ":memory:", manifestPath: replay.manifest!.path!,
    bindings: replay.bindings, duckdbInitSql: replay.duckdbInitSql,
    network: req.network, process: req.process, cas: req.cas,
    runId: `reproduce-${replay.runId}-${Date.now()}`, now: req.now,
  };

  let res: RunOperationResponse;
  // dispatch on the actual replay payload (robust regardless of the kind label): an operationId => a declared op;
  // otherwise the ad-hoc SQL path.
  if (replay.operationId) res = await runBioOperationFromManifest({ ...base, operationId: replay.operationId });
  else if (replay.sql) res = await runBioQueryFromManifest({ ...base, sql: replay.sql, resources: replay.resources });
  else throw new Error("reproduce: replay carries neither an operationId nor sql (nothing to re-run)");

  if (!res.ok) return { runId: replay.runId, kind: replay.kind, reproduced: false, matched: false, expected: replay.sourceReceiptDigests!, produced: [], missing: replay.sourceReceiptDigests!, extra: [], runDir: res.runDir, error: res.error };

  const produced = await producedDigests(res.runDir);
  const expected = replay.sourceReceiptDigests!;
  const producedSet = new Set(produced);
  const expectedSet = new Set(expected);
  const missing = expected.filter((d) => !producedSet.has(d));
  const extra = produced.filter((d) => !expectedSet.has(d));
  return { runId: replay.runId, kind: replay.kind, reproduced: true, matched: missing.length === 0 && extra.length === 0, expected, produced, missing, extra, runDir: res.runDir };
}
