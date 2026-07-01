// CoordinateSystem and Strand are the two genuinely CLOSED conventions in genomics (there are exactly two
// coordinate conventions and three strand states), and interval math branches on them — so they stay unions.
export type CoordinateSystem = "0-based-half-open" | "1-based-closed";
export type Strand = "+" | "-" | ".";

// An assembly is an OPEN identifier: GRCh38, GRCh38.p14, T2T-CHM13v2.0, GRCm39, dm6, and thousands more across
// species and patch levels. Enumerating three human builds and appending `| string` was a fake-closed union that
// documented nothing and misled — it is just a name the substrate carries through, never matched against a set.
export type Assembly = string;

// The kind of a bio value is an OPEN string — there is no closed taxonomy to enumerate (bioinformatics always
// has more, and consumers already extend it inline: tool IO adds "question"/"source"/… and the knowledge graph
// appends `| string`). Not even a "conventional list" constant: any such list is the same hardcoded taxonomy in
// a different syntax. It is just a label the substrate carries through.
export type BioPrimitiveKind = string;

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
  // an OPEN format label (vcf, bcf, bam, cram, bed, gff, parquet, h5ad, zarr, plink, … — bioinformatics has far
  // more, and new ones appear). It is carried through, never matched against a closed set, so it is plain string.
  format?: string;
  entityKind?: BioPrimitiveKind;
  assembly?: Assembly;
  coordinateSystem?: CoordinateSystem;
}
