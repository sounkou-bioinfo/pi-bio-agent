import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";

// The two-pillar flagship end to end: GWAS + eQTL loci -> SQL allele HARMONIZATION (DATA pillar) -> out-of-process
// R coloc.abf over Arrow IPC (COMPUTE pillar) -> colocalization posteriors. Real DAG, synthetic locus with a
// shared causal at rs6 (=> high PP.H4), one flipped-allele SNP (rs9) and one allele-mismatch SNP (rs12, dropped).
const MANIFEST = resolve(process.cwd(), "examples", "coloc", "manifest.json");
const PROVISION = ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"];

const rArrowAvailable = (() => {
  try {
    execFileSync("Rscript", ["-e", 'if(!requireNamespace("arrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" });
    return true;
  } catch { return false; }
})();

async function rows(sql: string): Promise<Array<Record<string, unknown>>> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-coloc-"));
  const out = await runBioQueryFromManifest({
    cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql,
    process: { runner: nodeProcessRunner() },
    duckdbInitSql: PROVISION, runId: "coloc", now: "T1",
  });
  assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
  if (!out.ok) return [];
  return (JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<Record<string, unknown>> }).rows;
}

describe("example: post-GWAS colocalization is a manifest — the two-pillar flagship (walking skeleton)", { skip: rArrowAvailable ? false : "Rscript + R 'arrow' not available" }, () => {
  test("DATA pillar: SQL harmonization aligns alleles, flips the swapped SNP, drops the mismatch", async () => {
    const h = await rows("SELECT snp, round(beta_eqtl, 3) AS beta_eqtl FROM harmonized ORDER BY snp");
    const snps = h.map((r) => r.snp);
    assert.equal(h.length, 11, "rs12 (allele mismatch) is dropped; 11 of 12 SNPs harmonize");
    assert.ok(!snps.includes("rs12"), "rs12 dropped");
    const rs9 = h.find((r) => r.snp === "rs9");
    assert.equal(Number(rs9!.beta_eqtl), 0.07, "rs9 alleles were swapped -> eqtl beta flipped -0.07 -> +0.07");
  });

  test("COMPUTE pillar: R coloc.abf over Arrow IPC concludes the GWAS and eQTL COLOCALIZE (high PP.H4)", async () => {
    const pp = await rows("SELECT hypothesis, round(posterior, 4) AS posterior, nsnps, engine FROM coloc_result ORDER BY hypothesis");
    assert.equal(pp.length, 5, "PP.H0..PP.H4");
    const byHyp = Object.fromEntries(pp.map((r) => [r.hypothesis, Number(r.posterior)]));
    const total = pp.reduce((a, r) => a + Number(r.posterior), 0);
    assert.ok(Math.abs(total - 1) < 0.01, `posteriors sum to ~1 (got ${total})`);
    assert.equal(Number(pp[0]!.nsnps), 11, "ran over the 11 harmonized SNPs");
    assert.ok(byHyp["PP.H4"] > 0.8, `PP.H4 (shared causal variant) is high — colocalized (got ${byHyp["PP.H4"]})`);
    assert.ok(byHyp["PP.H4"] > byHyp["PP.H3"], "PP.H4 (shared) dominates PP.H3 (distinct causals)");
  });
});
