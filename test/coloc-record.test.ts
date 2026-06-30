import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, recordObservation, observationsAsOf, materializeBioEdgesAsOf } from "../src/duckdb/observations.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";

// Phase 4.1: coloc is the first real PRODUCER of recorded judgments. The result of a DATA+COMPUTE run (per-tissue
// coloc.abf posteriors) becomes time-versioned KG facts: EVERY posterior as a SCALAR observation (so PP.H0–H3 are
// not hidden), plus the thresholded biological conclusion (PP.H4 > t) as an EDGE-like observation that projects
// into bio_edges_as_of. The mapping is coloc-specific so it stays in the test, not in src/.

type ColocRow = { tissue: string; hypothesis: string; posterior: number };

async function recordColocObservations(conn: SqlConn, rows: ColocRow[], o: { locusId: string; runId: string; resultDigest: string; recordedAt: string; threshold?: number }): Promise<void> {
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
  // the biological CALL — only when PP.H4 crosses the threshold — as an edge-like statement
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

async function obsConn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}

const NOW = "2026-06-30T00:00:00Z";

describe("Phase 4.1a: coloc posteriors recorded as temporal observations (deterministic, no R)", () => {
  // the three-way outcome the coloc example produces, as plain rows (no R needed)
  const rows: ColocRow[] = [
    ...["PP.H0", "PP.H1", "PP.H2", "PP.H3"].map((h) => ({ tissue: "Whole_Blood", hypothesis: h, posterior: 0 })),
    { tissue: "Whole_Blood", hypothesis: "PP.H4", posterior: 1.0 }, // colocalizes
    { tissue: "Liver", hypothesis: "PP.H3", posterior: 0.94 }, { tissue: "Liver", hypothesis: "PP.H4", posterior: 0.003 }, // different causal
    { tissue: "Brain", hypothesis: "PP.H1", posterior: 0.95 }, { tissue: "Brain", hypothesis: "PP.H4", posterior: 0.054 }, // no eQTL
  ];

  test("every posterior is a scalar fact; only the high-PP.H4 tissue becomes an edge", async () => {
    const c = await obsConn();
    await recordColocObservations(c, rows, { locusId: "locus1", runId: "run-A", resultDigest: "sha256:deadbeef", recordedAt: NOW });

    const asof = await observationsAsOf(c, NOW);
    // the numeric posterior survives as a scalar (PP.H0–H3 are NOT hidden — needed to read "not colocalized")
    const wbH4 = asof.find((r) => r.statement_key === "coloc:locus1:Whole_Blood:PP.H4");
    assert.equal(wbH4!.value_json, "1", "Whole_Blood PP.H4 recorded as a scalar");
    assert.equal(asof.find((r) => r.statement_key === "coloc:locus1:Liver:PP.H3")!.value_json, "0.94", "Liver PP.H3 recorded");
    assert.ok(asof.some((r) => r.statement_key === "coloc:locus1:Brain:PP.H1"), "Brain PP.H1 recorded (the no-eQTL signal)");

    // the biological call is an EDGE — only Whole_Blood (PP.H4 > 0.8) gets it
    const edges = await materializeBioEdgesAsOf(c, NOW);
    const rels = await c.all<{ from_id: string; to_id: string; predicate: string }>("SELECT from_id, to_id, predicate FROM bio_edges_as_of");
    assert.deepEqual(rels, [{ from_id: "tissue:Whole_Blood", to_id: "gwas_locus:locus1", predicate: "coloc:shares_causal_variant_with" }], "only Whole_Blood colocalizes; Liver/Brain (low H4) are NOT edges");
    assert.equal(edges, 1);
  });

  test("a re-run (new source) records a distinct provenance event; statement_key still controls as-of", async () => {
    const c = await obsConn();
    await recordColocObservations(c, [{ tissue: "Whole_Blood", hypothesis: "PP.H4", posterior: 1.0 }], { locusId: "locus1", runId: "run-A", resultDigest: "sha256:aaa", recordedAt: NOW });
    await recordColocObservations(c, [{ tissue: "Whole_Blood", hypothesis: "PP.H4", posterior: 1.0 }], { locusId: "locus1", runId: "run-B", resultDigest: "sha256:bbb", recordedAt: NOW }); // same value/time, DIFFERENT run
    const [{ n }] = await c.all<{ n: number }>("SELECT count(*) AS n FROM bio_observations WHERE statement_key='coloc:locus1:Whole_Blood:PP.H4'");
    assert.equal(Number(n), 2, "different source/digest -> two provenance rows (not collapsed)");
    assert.equal((await observationsAsOf(c, NOW)).filter((r) => r.statement_key === "coloc:locus1:Whole_Blood:PP.H4").length, 1, "but as-of still resolves to one current value");
  });
});

const rOk = (() => {
  try { execFileSync("Rscript", ["-e", 'if(!requireNamespace("nanoarrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe("Phase 4.1b: the REAL coloc run records its judgment (integration)", { skip: rOk ? false : "Rscript + R 'nanoarrow' not available" }, () => {
  test("run examples/coloc, then record its posteriors -> Whole_Blood colocalizes as a KG fact", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-coloc-rec-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: resolve(process.cwd(), "examples", "coloc", "manifest.json"),
      sql: "SELECT tissue, hypothesis, posterior FROM coloc_result",
      process: { runner: nodeProcessRunner() }, duckdbInitSql: ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"],
      runId: "coloc-rec", now: "T1",
    });
    assert.equal(out.ok, true, out.ok ? "" : `coloc run failed: ${(out as { error?: unknown }).error}`);
    if (!out.ok) return;
    const rows = (JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: ColocRow[] }).rows;

    const c = await obsConn();
    await recordColocObservations(c, rows, { locusId: "gwas1", runId: out.runId, resultDigest: "sha256:run", recordedAt: NOW });
    const asof = await observationsAsOf(c, NOW);
    const wbH4 = asof.find((r) => r.statement_key === "coloc:gwas1:Whole_Blood:PP.H4");
    assert.ok(wbH4 && Number(JSON.parse(wbH4.value_json!)) > 0.8, "the real coloc run recorded a high PP.H4 for Whole_Blood");
    await materializeBioEdgesAsOf(c, NOW);
    const edge = await c.all<{ from_id: string }>("SELECT from_id FROM bio_edges_as_of WHERE to_id='gwas_locus:gwas1' AND predicate='coloc:shares_causal_variant_with'");
    assert.deepEqual(edge.map((e) => e.from_id), ["tissue:Whole_Blood"], "Whole_Blood is recorded as colocalizing with the locus");
  });
});
