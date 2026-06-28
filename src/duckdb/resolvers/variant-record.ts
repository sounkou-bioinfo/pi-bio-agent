import type { BioViewDef } from "../../core/manifest.js";

// The variant record — the abstraction every variant provider must materialize. The record is the table
// SHAPE; the source format (VCF via duckhts.vcf_scan, CSV/Parquet via duckdb.file_scan, 23andMe, MAF, ...)
// is a swappable provider. An operation consumes this contract, never a specific format.
//
// CAVEAT — same columns != same normalized variant identity. `variant_key` is currently passed through
// verbatim from each provider; two providers can disagree on representation (chr prefix, indel
// left-alignment/trimming, genome build). This contract fixes the COLUMNAR shape only. Cross-provider key
// equivalence (assembly/seqid/pos/ref/alt -> a canonical variant_key) is deferred until a second real source
// actually disagrees — at which point normalization becomes a shared view/UDF the providers target.
export const ANNOTATED_VARIANTS_V1: BioViewDef = {
  id: "annotated_variants.v1",
  name: "annotated_variants",
  description: "One row per variant: provider-emitted identity plus consequence, frequency, and clinical significance.",
  columns: [
    { name: "variant_key", type: "TEXT", description: "Provider-emitted variant identity (NOT yet cross-provider normalized)." },
    { name: "consequence", type: "TEXT", nullable: true, description: "Sequence Ontology consequence CURIE." },
    { name: "allele_frequency", type: "DOUBLE", nullable: true, description: "Population allele frequency; NULL = unknown (abstain, do not treat as rare)." },
    { name: "clinical_significance", type: "TEXT", nullable: true, description: "Clinical significance label, e.g. Benign." },
  ],
};
