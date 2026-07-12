import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";

// Multi-tissue composition: GWAS + per-tissue eQTL loci -> SQL allele harmonization
// (DATA pillar) -> out-of-process R coloc.abf PER TISSUE over Arrow IPC (COMPUTE pillar; per-tissue = the
// partition+map) -> colocalization posteriors per tissue. The synthetic locus discriminates three outcomes:
// Whole_Blood SHARES the causal (rs6) with the GWAS (high PP.H4); Liver has a DIFFERENT causal (rs3) -> PP.H3;
// Brain has no eQTL signal -> PP.H1. Whole_Blood also exercises harmonization (rs9 allele-swap flip, rs12 drop).
const MANIFEST = resolve(process.cwd(), "examples", "coloc", "manifest.json");
const PROVISION = ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"];

const rArrowAvailable = (() => {
  try {
    execFileSync("Rscript", ["-e", 'if(!requireNamespace("nanoarrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" });
    return true;
  } catch { return false; }
})();

async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-coloc-"));
  const out = await runBioQueryFromManifest({
    cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql,
    compute: { runner: nodeComputeRunner() },
    duckdbInitSql: PROVISION, runId: "coloc", now: "T1",
  });
  assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
  if (!out.ok) return [];
  return (JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows;
}

describe("example: post-GWAS colocalization composes SQL harmonization and R compute", { skip: rArrowAvailable ? false : "Rscript + R 'nanoarrow' not available" }, () => {
  test("DATA pillar: SQL harmonization aligns/flips/drops per tissue", async () => {
    const h = await rows("SELECT tissue, count(*) AS n FROM harmonized GROUP BY tissue ORDER BY tissue");
    const byTissue = Object.fromEntries(h.map((r) => [r.tissue, Number(r.n)]));
    assert.equal(byTissue["Whole_Blood"], 11, "Whole_Blood drops the rs12 allele mismatch (11 of 12)");
    assert.equal(byTissue["Liver"], 12, "Liver alleles all align (12)");
    assert.equal(byTissue["Brain"], 12, "Brain alleles all align (12)");
    const rs9 = await rows("SELECT round(beta_eqtl,3) AS b FROM harmonized WHERE tissue='Whole_Blood' AND snp='rs9'");
    assert.equal(Number(rs9[0]!.b), 0.07, "Whole_Blood rs9 alleles were swapped -> eqtl beta flipped -0.07 -> +0.07");
  });

  test("COMPUTE pillar: per-tissue coloc.abf discriminates colocalization vs different-causal vs no-eQTL", async () => {
    const r = await rows(`SELECT tissue,
        round(max(CASE WHEN hypothesis='PP.H1' THEN posterior END),3) AS H1,
        round(max(CASE WHEN hypothesis='PP.H3' THEN posterior END),3) AS H3,
        round(max(CASE WHEN hypothesis='PP.H4' THEN posterior END),3) AS H4
      FROM coloc_result GROUP BY tissue`);
    const t = Object.fromEntries(r.map((x) => [x.tissue, x]));
    // Whole_Blood: SHARED causal -> high PP.H4
    assert.ok(Number(t["Whole_Blood"]!.H4) > 0.8, `Whole_Blood colocalizes (PP.H4=${t["Whole_Blood"]!.H4})`);
    // Liver: different causal -> PP.H3 dominates
    assert.ok(Number(t["Liver"]!.H3) > 0.8 && Number(t["Liver"]!.H3) > Number(t["Liver"]!.H4), `Liver shares the locus but a different causal (PP.H3=${t["Liver"]!.H3})`);
    // Brain: no eQTL signal -> PP.H1 (GWAS only) dominates
    assert.ok(Number(t["Brain"]!.H1) > 0.8 && Number(t["Brain"]!.H1) > Number(t["Brain"]!.H4), `Brain has GWAS signal only (PP.H1=${t["Brain"]!.H1})`);

    // the agent's actual question: which tissue colocalizes? -> the top PP.H4
    const top = await rows("SELECT tissue FROM coloc_result WHERE hypothesis='PP.H4' ORDER BY posterior DESC LIMIT 1");
    assert.equal(top[0]!.tissue, "Whole_Blood", "the colocalizing tissue is Whole_Blood");

    // errors-as-values: every row carries a status; the happy path is all "ok" (a failed tissue would be a row
    // with status="error: …", not a crashed job)
    const st = await rows("SELECT DISTINCT status FROM coloc_result");
    assert.deepEqual(st.map((r) => r.status), ["ok"], "all tissues computed (status=ok), errors would be in-band");
  });
});
