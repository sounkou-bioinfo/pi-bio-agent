export interface DuckDbExtensionDescriptor {
  name: string;
  source: "community" | "core" | "local" | "custom";
  purpose: string;
  installSql?: string;
  loadSql?: string;
  exampleSql?: string[];
  notes?: string[];
}

// Served on the pi wire as `text({ schema, extensions })` — the schema is a real envelope tag at that boundary.
export interface DuckDbExtensionCatalog {
  schema: "pi-bio.duckdb_extension_catalog.v1";
  extensions: DuckDbExtensionDescriptor[];
}

export const bioDuckDbExtensions: DuckDbExtensionDescriptor[] = [
  {
    name: "duckhts",
    source: "community",
    purpose: "HTS readers and utilities for VCF/BCF, BAM/CRAM/SAM, FASTA/FASTQ, BED, GTF/GFF, tabix, BGZF, indexing, sequence UDFs, and selected bcftools-compatible kernels.",
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
    installSql: "INSTALL httpfs;",
    loadSql: "LOAD httpfs;",
  },
  {
    name: "cache_httpfs",
    source: "community",
    purpose: "Transparent local block/range caching for httpfs remote reads (read_parquet/read_csv over http/s3 via duckdb.file_scan / duckdb.sql_materialize). This is the right reuse layer for DuckDB-OWNED remote I/O — a mutable, evictable PERFORMANCE cache, NOT a receipted artifact. It is complementary to, not a substitute for, our http.get CAS-of-bytes (which is whole-object provenance/reuse for bytes WE fetch). Set cache_httpfs_cache_directory to a host-owned dir.",
    installSql: "INSTALL cache_httpfs FROM community;",
    loadSql: "LOAD cache_httpfs;",
  },
  {
    name: "ducknng",
    source: "community",
    purpose: "Cross-process/cross-machine transport over NNG scalability protocols (pub/sub, push/pull, survey, bus, pair) plus framed Arrow-IPC RPC. Typed exec/query parameters travel as Arrow structs and are bound by the server's DuckDB, never interpolated into SQL text. createDucknngSqlConn exposes that lane through the host-neutral SQL port, including native TLS/mTLS handles backed by generated self-signed material, in-memory PEM, or files. Query sessions may mutate; hosts authorize query_open as well as opt-in exec with method auth, peer/IP allowlists, and SQL policy. The server owns the live mutable DB and clients hold no file lock. ducknng_ncurl / ducknng_ncurl_table provide SQL-native HTTP. RPC complements CAS-of-bytes: live mutable state versus durable immutable sharing. The community build is signed; a source build is unsigned, so the host sets allow_unsigned_extensions=true in duckdbConfig at DB open to load it.",
    installSql: "INSTALL ducknng FROM community;",
    loadSql: "LOAD ducknng;",
  },
  {
    name: "fts",
    source: "core",
    purpose: "Full-text indexes over local catalogs, ontology labels/synonyms, documents, and skill/capability descriptions.",
    installSql: "INSTALL fts;",
    loadSql: "LOAD fts;",
  },
  {
    name: "spatial",
    source: "core",
    purpose: "Useful for generic interval/tree experiments and geospatial public-health data; not a replacement for genomic interval semantics.",
    installSql: "INSTALL spatial;",
    loadSql: "LOAD spatial;",
  },
];

export const defaultDuckDbExtensionCatalog: DuckDbExtensionCatalog = {
  schema: "pi-bio.duckdb_extension_catalog.v1",
  extensions: bioDuckDbExtensions,
};

/** Substring search over the extension catalog's real content (name/source/purpose/notes/examples). Used by the
 *  pi-agent extension-discovery tool. */
export function findDuckDbExtensions(query: string): DuckDbExtensionDescriptor[] {
  const q = query.toLowerCase();
  return bioDuckDbExtensions.filter((ext) =>
    [ext.name, ext.source, ext.purpose, ...(ext.notes ?? []), ...(ext.exampleSql ?? [])].join("\n").toLowerCase().includes(q),
  );
}
