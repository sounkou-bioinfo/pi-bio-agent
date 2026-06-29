export interface DuckDbExtensionDescriptor {
  name: string;
  source: "community" | "core" | "local" | "custom";
  purpose: string;
  domains: string[];
  installSql?: string;
  loadSql?: string;
  exampleSql?: string[];
  notes?: string[];
}

export interface DuckDbExtensionCatalog {
  schema: "pi-bio.duckdb_extension_catalog.v1";
  extensions: DuckDbExtensionDescriptor[];
}

export const bioDuckDbExtensions: DuckDbExtensionDescriptor[] = [
  {
    name: "duckhts",
    source: "community",
    purpose: "HTS readers and utilities for VCF/BCF, BAM/CRAM/SAM, FASTA/FASTQ, BED, GTF/GFF, tabix, BGZF, indexing, sequence UDFs, and selected bcftools-compatible kernels.",
    domains: ["variants", "alignments", "intervals", "reference", "annotation"],
    installSql: "INSTALL duckhts FROM community;",
    loadSql: "LOAD duckhts;",
    exampleSql: [
      "SELECT * FROM read_bcf('sample.vcf.gz', tidy_format := true) LIMIT 10;",
      "SELECT * FROM read_bam('reads.bam', region := 'chr1:1-100000') LIMIT 10;",
      "SELECT * FROM read_gff('genes.gff3.gz', attributes_map := true) LIMIT 10;",
    ],
  },
  {
    name: "plinking_duck",
    source: "community",
    purpose: "Read PLINK 1/2 genotype datasets and run common genotype analytics such as frequency, missingness, LD, PRS, PCA, and GWAS-style regressions in SQL.",
    domains: ["genotypes", "gwas", "prs", "cohort-qc"],
    installSql: "INSTALL plinking_duck FROM community;",
    loadSql: "LOAD plinking_duck;",
    exampleSql: [
      "SELECT * FROM read_pfile('cohort', orient := 'variant') LIMIT 10;",
      "SELECT * FROM plink_freq('cohort.pgen') WHERE ALT_FREQ < 0.01 LIMIT 10;",
    ],
  },
  {
    name: "anndata",
    source: "community",
    purpose: "Read AnnData .h5ad single-cell datasets as SQL tables for obs, var, X, embeddings, layers, and pairwise matrices.",
    domains: ["single-cell", "matrix", "h5ad"],
    installSql: "INSTALL anndata FROM community;",
    loadSql: "LOAD anndata;",
    exampleSql: [
      "ATTACH 'data.h5ad' AS scdata (TYPE ANNDATA); SELECT * FROM scdata.obs LIMIT 10;",
      "SELECT * FROM anndata_scan_var('data.h5ad') LIMIT 10;",
    ],
  },
  {
    name: "duckdb_zarr",
    source: "community",
    purpose: "Explore Zarr stores via SQL, including group/array/chunk metadata and dense cell scans.",
    domains: ["zarr", "arrays", "imaging", "omics-matrix"],
    installSql: "INSTALL duckdb_zarr FROM community;",
    loadSql: "LOAD duckdb_zarr;",
    exampleSql: [
      "SELECT * FROM zarr_groups('dataset.zarr');",
      "SELECT * FROM zarr('dataset.zarr', 'X') LIMIT 10;",
    ],
  },
  {
    name: "httpfs",
    source: "core",
    purpose: "Read remote HTTPS and S3 datasets when explicitly allowed by policy and credentials.",
    domains: ["remote-io", "object-store"],
    installSql: "INSTALL httpfs;",
    loadSql: "LOAD httpfs;",
  },
  {
    name: "cache_httpfs",
    source: "community",
    purpose: "Transparent local block/range caching for httpfs remote reads (read_parquet/read_csv over http/s3 via duckdb.file_scan / duckdb.sql_materialize). This is the right reuse layer for DuckDB-OWNED remote I/O — a mutable, evictable PERFORMANCE cache, NOT a receipted artifact. It is complementary to, not a substitute for, our http.get CAS-of-bytes (which is whole-object provenance/reuse for bytes WE fetch). Set cache_httpfs_cache_directory to a host-owned dir.",
    domains: ["remote-io", "object-store", "cache"],
    installSql: "INSTALL cache_httpfs FROM community;",
    loadSql: "LOAD cache_httpfs;",
  },
  {
    name: "fts",
    source: "core",
    purpose: "Full-text indexes over local catalogs, ontology labels/synonyms, documents, and skill/capability descriptions.",
    domains: ["search", "catalog", "ontology"],
    installSql: "INSTALL fts;",
    loadSql: "LOAD fts;",
  },
  {
    name: "spatial",
    source: "core",
    purpose: "Useful for generic interval/tree experiments and geospatial public-health data; not a replacement for genomic interval semantics.",
    domains: ["public-health", "geometry"],
    installSql: "INSTALL spatial;",
    loadSql: "LOAD spatial;",
  },
];

export const defaultDuckDbExtensionCatalog: DuckDbExtensionCatalog = {
  schema: "pi-bio.duckdb_extension_catalog.v1",
  extensions: bioDuckDbExtensions,
};

export function findDuckDbExtensions(query: string): DuckDbExtensionDescriptor[] {
  const q = query.toLowerCase();
  return bioDuckDbExtensions.filter((ext) => [ext.name, ext.purpose, ...ext.domains].join("\n").toLowerCase().includes(q));
}
