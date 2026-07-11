import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BioManifest } from "pi-bio-agent";

export interface CandidateVariantSearchRuntime {
  assembly: string;
  intervalManifestPath: string;
  intervalOperationId: "clinical.candidate_gene_intervals";
  variantSearchManifestPath: string;
  variantSearchOperationId: "clinical.candidate_variant_search";
  manifestBaseDir: string;
  vcfPath: string;
  sourceVersion: string;
  duckdbInitSql: string[];
}

export interface CandidateIntervalRow {
  gene_id: string;
  gene: string;
  disease_id: string;
  hypothesis_rank: number;
  assembly: string;
  chrom: string | null;
  start_1based: number | null;
  end_1based: number | null;
  interval_status: "resolved" | "ambiguous_locus" | "missing_gene_interval";
}

const EMPTY_VCF_SQL = `SELECT
  NULL::VARCHAR AS CHROM,
  NULL::BIGINT AS POS,
  NULL::VARCHAR AS REF,
  NULL::VARCHAR[] AS ALT,
  NULL::VARCHAR[] AS INFO_GENE,
  NULL::VARCHAR[] AS INFO_CSQ,
  NULL::FLOAT[] AS INFO_AF,
  NULL::VARCHAR[] AS INFO_CLNSIG,
  NULL::VARCHAR[] AS INFO_ZYGOSITY,
  NULL::VARCHAR[] AS INFO_INHERITANCE
WHERE FALSE`;

const EMPTY_CONTIG_SQL = `SELECT
  NULL::VARCHAR AS chrom,
  NULL::BIGINT AS length,
  NULL::VARCHAR AS assembly
WHERE FALSE`;

const CASE_VCF_CONTIG_SQL = `SELECT
  id AS chrom,
  length,
  map_extract_value(key_values, 'assembly') AS assembly
FROM read_hts_header(getvariable('case_vcf_path'))
WHERE record_type = 'contig'`;

export function buildCandidateVariantSearchManifest(
  template: BioManifest,
  intervals: CandidateIntervalRow[],
  runtime: CandidateVariantSearchRuntime,
): { manifest: BioManifest; regions: string[] } {
  const manifest = structuredClone(template);
  const resource = manifest.provides?.resources?.find((candidate) => candidate.id === "case_vcf_raw");
  if (!resource) throw new Error("candidate variant-search manifest has no 'case_vcf_raw' resource");
  const contigs = manifest.provides?.resources?.find((candidate) => candidate.id === "case_vcf_contigs");
  if (!contigs) throw new Error("candidate variant-search manifest has no 'case_vcf_contigs' resource");
  const regions: string[] = [];
  const seen = new Set<string>();

  for (const interval of intervals) {
    if (interval.interval_status !== "resolved") continue;
    if (interval.assembly !== runtime.assembly) {
      throw new Error(`resolved interval for '${interval.gene_id}' uses ${interval.assembly}, expected ${runtime.assembly}`);
    }
    const chrom = String(interval.chrom ?? "").trim();
    const start = Number(interval.start_1based);
    const end = Number(interval.end_1based);
    if (!chrom || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
      throw new Error(`resolved interval for '${interval.gene_id}' is malformed`);
    }
    const region = `${chrom}:${start}-${end}`;
    if (!seen.has(region)) {
      seen.add(region);
      regions.push(region);
    }
  }

  if (regions.length === 0) {
    resource.resolver = "duckdb.sql_materialize";
    resource.params = { table: "case_vcf_raw", sql: EMPTY_VCF_SQL };
    contigs.resolver = "duckdb.sql_materialize";
    contigs.params = { table: "case_vcf_contigs", sql: EMPTY_CONTIG_SQL };
  } else {
    resource.resolver = "duckhts.read_bcf";
    resource.params = {
      path: runtime.vcfPath,
      table: "case_vcf_raw",
      region: regions.join(","),
      sourceVersion: runtime.sourceVersion,
    };
    contigs.params = {
      table: "case_vcf_contigs",
      sql: CASE_VCF_CONTIG_SQL,
      declaredSources: [runtime.vcfPath.includes("://") ? runtime.vcfPath : `file:${runtime.vcfPath}`],
    };
  }
  return { manifest, regions };
}

export function localCandidateVariantSearchRuntime(workspace: string): CandidateVariantSearchRuntime {
  // This helper hashes the tiny hermetic fixture. Production hosts supply a sourceVersion without reading a large VCF whole.
  const root = resolve(workspace);
  const vcfPath = "data/case_variants.vcf.gz";
  const dataPath = resolve(root, vcfPath);
  const hash = createHash("sha256")
    .update(readFileSync(dataPath))
    .update("\0")
    .update(readFileSync(`${dataPath}.tbi`))
    .digest("hex");
  return {
    assembly: "GRCh38",
    intervalManifestPath: resolve(root, "gene-intervals.manifest.json"),
    intervalOperationId: "clinical.candidate_gene_intervals",
    variantSearchManifestPath: resolve(root, "variant-search.manifest.json"),
    variantSearchOperationId: "clinical.candidate_variant_search",
    manifestBaseDir: root,
    vcfPath,
    sourceVersion: `sha256:${hash}`,
    duckdbInitSql: ["LOAD duckhts"],
  };
}
