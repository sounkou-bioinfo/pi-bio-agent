import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainPackManifest } from "../src/core/manifest.js";
import { runBioOperationFromManifest, runsRoot } from "../src/hosts/run-store.js";

// End-to-end through the host: a manifest JSON on disk -> validated registry -> built-in resolvers -> a
// duckdb.sql operation -> persisted run/result/report/receipts. Both resources use duckdb.file_scan (a
// built-in), so nothing test-only is bound; this is what a real host run looks like.

const RARE_HIGH_IMPACT_SQL = [
  "SELECT variant_key, consequence, allele_frequency,",
  "  CASE",
  "    WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "    WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_high_impact'",
  "    WHEN clinical_significance = 'Benign' THEN 'benign'",
  "    WHEN allele_frequency >= 0.01 THEN 'not_rare'",
  "    ELSE 'included'",
  "  END AS bucket",
  "FROM annotated_variants ORDER BY variant_key",
].join("\n");

const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1",
  id: "rare-high-impact-host",
  version: "0.1.0",
  title: "Rare high-impact (host)",
  description: "Rare LoF variants over CSV providers, run through the host.",
  domains: ["genomics"],
  provides: {
    resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a DuckDB-native file into a table.", output: { mode: "table" } }],
    resources: [
      // project-relative paths — resolved against the manifest's directory, not the process cwd
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data/annotated_variants.csv", table: "annotated_variants" } },
      { id: "so_loss_of_function", title: "LoF SO terms", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data/so_loss_of_function.csv", table: "so_loss_of_function" } },
    ],
    operations: [{
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["annotated_variants", "so_loss_of_function"], requiredColumns: ["variant_key", "consequence", "allele_frequency", "clinical_significance"] },
      report: { kind: "bucketed_rows", idColumn: "variant_key", bucketColumn: "bucket", includedBucket: "included", caveats: ["Unknown frequency is abstained.", "Benign is excluded."] },
    }],
  },
};

async function tmpProject(m: DomainPackManifest): Promise<string> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "biorun-"));
  await fs.mkdir(join(cwd, "data"), { recursive: true });
  await fs.copyFile("test/fixtures/annotated_variants.csv", join(cwd, "data", "annotated_variants.csv"));
  await fs.copyFile("test/fixtures/so_loss_of_function.csv", join(cwd, "data", "so_loss_of_function.csv"));
  await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(m), "utf8");
  return cwd;
}
const run = (cwd: string, runId = "run-1") =>
  runBioOperationFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", operationId: "rare_high_impact.report", runId, now: "2026-06-28T00:00:00Z" });

describe("host: bio_run_operation end-to-end", () => {
  test("runs a manifest operation and persists run/result/report/receipts", async () => {
    const cwd = await tmpProject(manifest);
    const res = await run(cwd);
    assert.equal(res.ok, true);
    assert.equal(res.status, "succeeded");
    assert.equal(res.report?.included, 1); // ClawBio rhi_01 ground truth, via the host
    assert.equal(res.report?.countsByBucket.no_frequency, 1);

    // the four artifacts exist, parse, and carry the right content
    const dir = join(runsRoot(cwd), "run-1");
    assert.equal(res.runDir, dir);
    const run_ = JSON.parse(await fs.readFile(join(dir, "run.json"), "utf8"));
    const result = JSON.parse(await fs.readFile(join(dir, "result.json"), "utf8"));
    const report = JSON.parse(await fs.readFile(join(dir, "report.json"), "utf8"));
    const receipts = JSON.parse(await fs.readFile(join(dir, "receipts.json"), "utf8"));
    assert.equal(run_.status, "succeeded");
    assert.equal(result.rows.length, 5);
    assert.equal(report.included, 1);
    const avReceipt = receipts.find((r: { resourceId: string }) => r.resourceId === "annotated_variants");
    assert.equal(avReceipt.resolverId, "duckdb.file_scan");
    // the relative manifest path was resolved to an absolute file under the project, not the process cwd
    assert.ok(avReceipt.sourceSnapshots.some((s: { source: string }) => s.source === `file:${join(cwd, "data", "annotated_variants.csv")}`));
    assert.equal(res.artifacts.report, join(dir, "report.json"));
  });

  test("fails closed on an invalid manifest", async () => {
    const cwd = await tmpProject({ ...manifest, schema: "nope" as never });
    await assert.rejects(() => run(cwd), /invalid manifest/);
  });

  test("fails closed when a declared resolver is not a host built-in", async () => {
    const m: DomainPackManifest = {
      ...manifest,
      provides: {
        ...manifest.provides,
        resolvers: [{ id: "mystery.scan", version: "0.1.0", title: "Mystery", description: "Not a built-in.", output: { mode: "table" } }],
        resources: [{ id: "annotated_variants", title: "AV", kind: "virtual", resolver: "mystery.scan", params: { path: "x" } }],
        operations: [{
          schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0", title: "T", description: "t", domains: ["genomics"],
          transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT 1 AS variant_key FROM annotated_variants", readOnly: true, requiredResources: ["annotated_variants"] },
        }],
      },
    };
    const cwd = await tmpProject(m);
    await assert.rejects(() => run(cwd), /no implementation is bound/);
  });
});
