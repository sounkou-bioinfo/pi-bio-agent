import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";

// The #3 artifact transport: a compute op returns a VALUE (Arrow table) AND writes declared FILE outputs that the
// resolver captures into CAS (content-addressed) — files never enter the IPC (the nf-r-ipc/Nextflow split).
const MANIFEST = resolve(process.cwd(), "examples", "compute-artifacts", "manifest.json");
const PROVISION = ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"];

const rOk = (() => {
  try { execFileSync("Rscript", ["-e", 'if(!requireNamespace("nanoarrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe("example: compute.run with FILE outputs captured into CAS (the #3 artifact transport)", { skip: rOk ? false : "Rscript + R 'nanoarrow' not available" }, () => {
  test("returns the value as a table AND captures declared file outputs into CAS with receipts", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-artifacts-"));
    const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(casDir);
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: MANIFEST,
      sql: "SELECT n, mean_x, status FROM summary",
      compute: { runner: nodeComputeRunner() }, cas,
      duckdbInitSql: PROVISION, runId: "art", now: "T1",
    });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    if (!out.ok) return;

    // the VALUE came back as a table
    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ n: number; mean_x: number; status: string }> };
    assert.deepEqual(result.rows, [{ n: 5, mean_x: 3, status: "ok" }]);

    // the FILE outputs are in the receipt as content-addressed artifacts
    const receipts = JSON.parse(await fs.readFile(join(out.runDir, "receipts.json"), "utf8")) as Array<{ resourceId: string; provenance: Array<{ source: string; digest?: string; notes?: string[] }> }>;
    const summary = receipts.find((r) => r.resourceId === "summary")!;
    assert.ok(
      summary.provenance.some((p) => p.source === "compute.run" && p.notes?.some((note) => /^cmd:Rscript .*summarize\.R$/.test(note))),
      "receipt records the R renderer command",
    );
    const artifacts = summary.provenance.filter((p) => p.source.startsWith("artifact:"));
    assert.equal(artifacts.length, 3, "three declared file outputs captured");
    const byName = Object.fromEntries(artifacts.map((a) => [a.source, a]));
    for (const name of ["artifact:rows_csv", "artifact:report", "artifact:plot_svg"]) {
      const a = byName[name]!;
      assert.match(a.digest ?? "", /^sha256:[0-9a-f]{64}$/, `${name} has a sha256 digest`);
      // the bytes are actually in CAS at that address
      const digest = a.digest!.replace("sha256:", "");
      assert.equal(await cas.has({ algorithm: "sha256", digest }), true, `${name} bytes are in CAS`);
    }

    // and the captured content is the real file (read the 'report' artifact back from CAS)
    const reportDigest = byName["artifact:report"]!.digest!.replace("sha256:", "");
    const reportBytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: reportDigest }), "utf8");
    assert.match(reportBytes, /rows: 5/, "the captured report.txt has the real content");

    const plotDigest = byName["artifact:plot_svg"]!.digest!.replace("sha256:", "");
    const plotBytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: plotDigest }), "utf8");
    assert.match(plotBytes, /<svg[^>]*>/, "the captured plot.svg is a real SVG");
    assert.match(plotBytes, /<\/svg>/, "the captured plot.svg is complete");
  });

  test("fails closed when outputs are declared but no CAS is bound", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-artifacts-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM summary",
      compute: { runner: nodeComputeRunner() }, // no `cas`
      duckdbInitSql: PROVISION, runId: "art2", now: "T1",
    });
    assert.equal(out.ok, false, "declared file outputs require a CAS store -> fail closed");
  });
});
