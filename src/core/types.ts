export type CoordinateSystem = "0-based-half-open" | "1-based-closed";
export type Strand = "+" | "-" | ".";
export type Assembly = "GRCh37" | "GRCh38" | "T2T-CHM13" | string;

export type BioPrimitiveKind = "genomic_interval" | "variant" | "ontology_term" | "artifact" | "table";

export interface Provenance {
  source: string;
  version?: string;
  command?: string[];
  sql?: string;
  digest?: string;
  retrievedAt?: string;
  notes?: string[];
}

export interface BioArtifact {
  kind: "artifact";
  role: "input" | "output" | "cache" | "reference" | "report";
  path: string;
  format?: string;
  mediaType?: string;
  entityKind?: BioPrimitiveKind;
  assembly?: Assembly;
  digest?: string;
  provenance?: Provenance[];
}

export interface GenomicInterval {
  kind: "genomic_interval";
  seqid: string;
  start: number;
  end: number;
  coordinateSystem: CoordinateSystem;
  assembly?: Assembly;
  strand?: Strand;
  name?: string;
  source?: Provenance;
}

export interface VariantKey {
  kind: "variant";
  seqid: string;
  pos: number;
  ref: string;
  alt: string;
  coordinateSystem: "1-based-closed";
  assembly?: Assembly;
  id?: string;
}

export interface OntologyTermRef {
  kind: "ontology_term";
  system: string;
  id: string;
  label?: string;
  iri?: string;
}

export interface BioSource {
  id?: string;
  label?: string;
  path?: string;
  table?: string;
  sql?: string;
  format?: "vcf" | "bcf" | "bam" | "cram" | "bed" | "gff" | "gtf" | "fasta" | "fastq" | "parquet" | "csv" | "tsv" | "json" | "h5ad" | "zarr" | "plink" | "duckdb_table" | "sql" | string;
  entityKind?: BioPrimitiveKind;
  assembly?: Assembly;
  coordinateSystem?: CoordinateSystem;
}
