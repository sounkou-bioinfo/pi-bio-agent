import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runBioOperationFromManifest, type BioManifest } from "pi-bio-agent";
import {
  buildCandidateVariantSearchManifest,
  localCandidateVariantSearchRuntime,
  type CandidateIntervalRow,
} from "../src/candidate-variant-search.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-search-"));
  await fs.cp(fixtureRoot, dir, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  return dir;
}

test("the checked-in BGZF fixture is the indexed form of the readable VCF source", async () => {
  const source = await fs.readFile(join(fixtureRoot, "data", "case_variants.vcf"));
  const compressed = await fs.readFile(join(fixtureRoot, "data", "case_variants.vcf.gz"));
  assert.deepEqual(gunzipSync(compressed), source);
});

test("overlapping indexed regions deduplicate raw VCF rows per selected gene and allele", async () => {
  const workspace = await copyFixture();
  const runtime = localCandidateVariantSearchRuntime(workspace);
  const template = JSON.parse(await fs.readFile(runtime.variantSearchManifestPath, "utf8")) as BioManifest;
  const intervals: CandidateIntervalRow[] = [
    {
      gene_id: "HGNC:GENEB", gene: "GENEB", disease_id: "MONDO:GENEB", hypothesis_rank: 1,
      assembly: "GRCh38", chrom: "17", start_1based: 43090000, end_1based: 43100000, interval_status: "resolved",
    },
    {
      gene_id: "HGNC:OVER", gene: "OVER", disease_id: "MONDO:OVER", hypothesis_rank: 2,
      assembly: "GRCh38", chrom: "17", start_1based: 43093460, end_1based: 43093480, interval_status: "resolved",
    },
  ];
  const dynamic = buildCandidateVariantSearchManifest(template, intervals, runtime);
  assert.deepEqual(dynamic.regions, ["17:43090000-43100000", "17:43093460-43093480"]);

  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestSnapshot: dynamic.manifest,
    manifestBaseDir: workspace,
    operationId: runtime.variantSearchOperationId,
    runId: "overlapping-search",
    duckdbInitSql: runtime.duckdbInitSql,
    bindings: { case_id: "CASE-RD-001" },
    protectedSessionBindings: {
      intervals_json: JSON.stringify(intervals),
      case_vcf_path: resolve(workspace, runtime.vcfPath),
    },
    protectedSessionVariables: ["intervals_json", "case_vcf_path"],
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const rows = response.result.rows as Array<Record<string, unknown>>;
  const variants = rows.filter((row) => row.record_kind === "variant");
  assert.equal(variants.length, 6, "each selected gene sees three alleles, without duplicate rows from overlapping iterators");
  assert.deepEqual(
    variants.filter((row) => row.gene === "GENEB").map((row) => row.variant_key).sort(),
    ["17-43093464-A-T", "17-43093470-C-G", "17-43093470-C-T"],
  );
  assert.deepEqual(
    rows.filter((row) => row.record_kind === "coverage").map((row) => [row.gene, Number(row.searched_variant_count)]),
    [["GENEB", 3], ["OVER", 3]],
  );
});

test("an unresolved gene produces explicit unsearched coverage without loading DuckHTS or scanning the whole VCF", async () => {
  const workspace = await copyFixture();
  const runtime = localCandidateVariantSearchRuntime(workspace);
  const template = JSON.parse(await fs.readFile(runtime.variantSearchManifestPath, "utf8")) as BioManifest;
  const intervals: CandidateIntervalRow[] = [{
    gene_id: "HGNC:MISSING", gene: "MISSING", disease_id: "MONDO:MISSING", hypothesis_rank: 1,
    assembly: "GRCh38", chrom: null, start_1based: null, end_1based: null, interval_status: "missing_gene_interval",
  }];
  const dynamic = buildCandidateVariantSearchManifest(template, intervals, runtime);
  assert.deepEqual(dynamic.regions, []);
  assert.equal(dynamic.manifest.provides?.resources?.find((resource) => resource.id === "case_vcf_raw")?.resolver, "duckdb.sql_materialize");

  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestSnapshot: dynamic.manifest,
    manifestBaseDir: workspace,
    operationId: runtime.variantSearchOperationId,
    runId: "unresolved-search",
    bindings: { case_id: "CASE-RD-001" },
    protectedSessionBindings: {
      intervals_json: JSON.stringify(intervals),
      case_vcf_path: resolve(workspace, runtime.vcfPath),
    },
    protectedSessionVariables: ["intervals_json", "case_vcf_path"],
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.deepEqual(response.result.rows, [{
    record_kind: "coverage",
    case_id: "CASE-RD-001",
    gene_id: "HGNC:MISSING",
    gene: "MISSING",
    disease_ids: ["MONDO:MISSING"],
    hypothesis_rank: 1,
    assembly: "GRCh38",
    chrom: null,
    start_1based: null,
    end_1based: null,
    search_status: "missing_gene_interval",
    search_scope: null,
    searched_variant_count: 0,
    variant_key: null,
    pos: null,
    ref: null,
    alt: null,
    annotated_gene: null,
    consequence: null,
    allele_frequency: null,
    clinical_significance: null,
    zygosity: null,
    inheritance: null,
  }]);
});

test("an absent VCF contig fails instead of masquerading as completed zero-result coverage", async () => {
  const workspace = await copyFixture();
  const runtime = localCandidateVariantSearchRuntime(workspace);
  const template = JSON.parse(await fs.readFile(runtime.variantSearchManifestPath, "utf8")) as BioManifest;
  const intervals: CandidateIntervalRow[] = [{
    gene_id: "HGNC:ABSENT", gene: "ABSENT", disease_id: "MONDO:ABSENT", hypothesis_rank: 1,
    assembly: "GRCh38", chrom: "99", start_1based: 100, end_1based: 200, interval_status: "resolved",
  }];
  const dynamic = buildCandidateVariantSearchManifest(template, intervals, runtime);
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestSnapshot: dynamic.manifest,
    manifestBaseDir: workspace,
    operationId: runtime.variantSearchOperationId,
    runId: "absent-contig",
    duckdbInitSql: runtime.duckdbInitSql,
    bindings: { case_id: "CASE-RD-001" },
    protectedSessionBindings: {
      intervals_json: JSON.stringify(intervals),
      case_vcf_path: resolve(workspace, runtime.vcfPath),
    },
    protectedSessionVariables: ["intervals_json", "case_vcf_path"],
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.match(response.error, /absent VCF contig 99/);
});

test("VCF header assembly metadata must agree with the assembly-pinned intervals", async () => {
  const workspace = await copyFixture();
  const runtime = { ...localCandidateVariantSearchRuntime(workspace), assembly: "GRCh37" };
  const template = JSON.parse(await fs.readFile(runtime.variantSearchManifestPath, "utf8")) as BioManifest;
  const intervals: CandidateIntervalRow[] = [{
    gene_id: "HGNC:GENEB", gene: "GENEB", disease_id: "MONDO:GENEB", hypothesis_rank: 1,
    assembly: "GRCh37", chrom: "17", start_1based: 43090000, end_1based: 43100000, interval_status: "resolved",
  }];
  const dynamic = buildCandidateVariantSearchManifest(template, intervals, runtime);
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestSnapshot: dynamic.manifest,
    manifestBaseDir: workspace,
    operationId: runtime.variantSearchOperationId,
    runId: "vcf-assembly-mismatch",
    duckdbInitSql: runtime.duckdbInitSql,
    bindings: { case_id: "CASE-RD-001" },
    protectedSessionBindings: {
      intervals_json: JSON.stringify(intervals),
      case_vcf_path: resolve(workspace, runtime.vcfPath),
    },
    protectedSessionVariables: ["intervals_json", "case_vcf_path"],
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.match(response.error, /assembly mismatch on contig 17/);
});

test("a known gene available only on another assembly fails interval resolution", async () => {
  const workspace = await copyFixture();
  await fs.appendFile(
    join(workspace, "data", "gene_intervals.csv"),
    "HGNC:OTHER,OTHER,GRCh37,1,100,200,fixture:gene-intervals,fixture-1\n",
  );
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "gene-intervals.manifest.json",
    operationId: "clinical.candidate_gene_intervals",
    runId: "assembly-mismatch",
    bindings: { case_id: "CASE-RD-001", assembly: "GRCh38" },
    protectedSessionBindings: {
      hypotheses_json: JSON.stringify([{ gene_id: "HGNC:OTHER", gene: "OTHER", disease_id: "MONDO:OTHER", hypothesis_rank: 1 }]),
    },
    protectedSessionVariables: ["hypotheses_json"],
  });
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.match(response.error, /assembly mismatch.*HGNC:OTHER.*GRCh38/);
});
