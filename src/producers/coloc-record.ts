import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ProcessRunner, SqlConn } from "../core/ports.js";
import { recordObservation } from "../duckdb/observations.js";
import { runBioQueryFromManifest } from "../hosts/run-store.js";

// Phase 4.1 — coloc is the first real PRODUCER of recorded judgments. It is ONE producer, NOT a shape the
// substrate core bends toward: the mapping below lives HERE (a scoped producer module), never in src/core, and
// leans only on the GENERIC recordObservation. The result of a DATA+COMPUTE run (per-tissue coloc.abf posteriors)
// becomes time-versioned KG facts: EVERY posterior as a SCALAR observation (so PP.H0-H3 are not hidden), plus the
// thresholded biological conclusion (PP.H4 > t) as an EDGE-like observation that projects into bio_edges_as_of.

export type ColocRow = { tissue: string; hypothesis: string; posterior: number };

export interface RecordColocOpts {
  locusId: string;
  runId: string;
  resultDigest: string;
  recordedAt: string;
  threshold?: number;
}

export async function recordColocObservations(conn: SqlConn, rows: ColocRow[], o: RecordColocOpts): Promise<void> {
  const threshold = o.threshold ?? 0.8;
  for (const r of rows) {
    await recordObservation(conn, {
      statementKey: `coloc:${o.locusId}:${r.tissue}:${r.hypothesis}`,
      subjectId: `coloc:${o.locusId}:${r.tissue}`, predicate: `coloc:posterior:${r.hypothesis}`,
      value: r.posterior, recordedAt: o.recordedAt, source: o.runId, digest: o.resultDigest,
      attrs: { tissue: r.tissue, hypothesis: r.hypothesis, locusId: o.locusId },
      trust: { provenanceClass: "computed", confidence: r.posterior, producer: "coloc.abf" },
    });
  }
  // the biological CALL — only when PP.H4 crosses the threshold — as an edge-like statement. NOTE: the threshold
  // is part of the call's IDENTITY; observation_id excludes attrs, so if the rule changes independently of the
  // result, fold the rule into source/digest (here the result digest changes per run, so it's covered).
  const h4 = new Map(rows.filter((r) => r.hypothesis === "PP.H4").map((r) => [r.tissue, r.posterior]));
  for (const [tissue, pp] of h4) {
    if (pp <= threshold) continue;
    await recordObservation(conn, {
      statementKey: `coloc:${o.locusId}:${tissue}:shared-causal-call`,
      subjectId: `tissue:${tissue}`, predicate: "coloc:shares_causal_variant_with", objectId: `gwas_locus:${o.locusId}`,
      recordedAt: o.recordedAt, source: o.runId, digest: o.resultDigest,
      attrs: { pp_h4: pp, threshold, hypothesis: "PP.H4" },
      trust: { provenanceClass: "computed", confidence: pp, producer: "coloc.abf" },
    });
  }
}

/** Coerce the coloc_result rows (tissue, hypothesis, posterior; coloc.R emits NA posteriors for per-tissue errors
 *  as VALUES) into clean numeric ColocRows — dropping rows with no tissue or a non-finite posterior. */
export function parseColocResultRows(raw: ReadonlyArray<Record<string, unknown>>): ColocRow[] {
  const out: ColocRow[] = [];
  for (const r of raw) {
    const tissue = r.tissue, hypothesis = r.hypothesis, posterior = Number(r.posterior);
    if (typeof tissue !== "string" || typeof hypothesis !== "string" || !Number.isFinite(posterior)) continue;
    out.push({ tissue, hypothesis, posterior });
  }
  return out;
}

export interface RunColocRecordArgs {
  cwd: string;
  manifestPath: string;
  /** the bio_observations connection the posteriors are recorded into (the ONE store). */
  store: SqlConn;
  processRunner: ProcessRunner;
  locusId: string;
  runId: string;
  recordedAt: string;
  now?: string;
  threshold?: number;
  dbPath?: string;
  duckdbInitSql?: string[];
}

export interface RunColocRecordResult {
  ok: boolean;
  runId: string;
  rows: ColocRow[];
  recorded: number;
  resultDigest?: string;
  error?: string;
}

const NANOARROW_INIT = ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"];

/** The PRODUCTION pipeline: run the coloc manifest (process.compute -> coloc.R -> posteriors table) through the
 *  host, parse its result.json posteriors, and record them into the store via the shared recorder. This is "the
 *  production run records its judgment" — the same function the example CLI and the integration test both drive,
 *  so the mapping is exercised end to end, not only in a unit test. */
export async function runColocRecord(args: RunColocRecordArgs): Promise<RunColocRecordResult> {
  const out = await runBioQueryFromManifest({
    cwd: args.cwd, dbPath: args.dbPath ?? ":memory:", manifestPath: args.manifestPath,
    sql: "SELECT tissue, hypothesis, posterior FROM coloc_result",
    process: { runner: args.processRunner }, duckdbInitSql: args.duckdbInitSql ?? NANOARROW_INIT,
    runId: args.runId, now: args.now ?? args.recordedAt,
  });
  if (!out.ok) return { ok: false, runId: out.runId, rows: [], recorded: 0, error: out.error };
  const bytes = await fs.readFile(join(out.runDir, "result.json"), "utf8");
  const rows = parseColocResultRows((JSON.parse(bytes) as { rows: Array<Record<string, unknown>> }).rows);
  // content-address the posteriors themselves as the observation digest (a real content digest, not a run token).
  const resultDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await recordColocObservations(args.store, rows, { locusId: args.locusId, runId: out.runId, resultDigest, recordedAt: args.recordedAt, threshold: args.threshold });
  return { ok: true, runId: out.runId, rows, recorded: rows.length, resultDigest };
}
