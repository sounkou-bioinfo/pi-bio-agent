export type CoordinateSystem = "0-based-half-open" | "1-based-closed";
export type Strand = "+" | "-" | ".";
export type Assembly = "GRCh37" | "GRCh38" | "T2T-CHM13" | string;

export type BioPrimitiveKind =
  | "genomic_interval"
  | "variant"
  | "feature"
  | "sample"
  | "cohort"
  | "ontology_term"
  | "tree"
  | "matrix"
  | "table"
  | "artifact"
  | "evidence"
  | "workflow_state";

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

export interface Feature {
  kind: "feature";
  id: string;
  type: string;
  interval: GenomicInterval;
  parentId?: string;
  attributes?: Record<string, string | number | boolean | null>;
  ontology?: OntologyTermRef[];
}

export interface Sample {
  kind: "sample";
  id: string;
  organism?: string;
  assembly?: Assembly;
  attributes?: Record<string, string | number | boolean | null>;
}

export interface Cohort {
  kind: "cohort";
  id: string;
  samples: Sample[];
  attributes?: Record<string, string | number | boolean | null>;
}

export interface OntologyTermRef {
  kind: "ontology_term";
  system: string;
  id: string;
  label?: string;
  iri?: string;
}

export interface OntologyTerm extends OntologyTermRef {
  synonyms?: string[];
  parents?: OntologyTermRef[];
  xrefs?: OntologyTermRef[];
  obsolete?: boolean;
}

export interface DomainTree {
  kind: "tree";
  id: string;
  nodeTable: string;
  edgeTable: string;
  nodeIdColumn: string;
  parentIdColumn?: string;
  leftColumn?: string;
  rightColumn?: string;
  labelColumn?: string;
  provenance?: Provenance[];
}

export interface MatrixModel {
  kind: "matrix";
  id: string;
  shape?: [number, number];
  rowAxis: "sample" | "cell" | "variant" | "feature" | "gene" | string;
  columnAxis: "sample" | "cell" | "variant" | "feature" | "gene" | string;
  valueType?: "count" | "dosage" | "expression" | "probability" | "score" | string;
  backing?: BioArtifact;
}

export interface Evidence {
  kind: "evidence";
  id?: string;
  claim: string;
  value?: unknown;
  unit?: string;
  support: Provenance[];
  qualifiers?: Record<string, unknown>;
}

export interface FactBundle {
  schema: "pi-bio.fact_bundle.v1";
  facts: Evidence[];
  unresolvedQuestions?: string[];
  summaryLines?: string[];
  artifacts?: BioArtifact[];
}

export type BioEntity =
  | GenomicInterval
  | VariantKey
  | Feature
  | Sample
  | Cohort
  | OntologyTerm
  | DomainTree
  | MatrixModel
  | BioArtifact
  | Evidence;

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

export interface AnalysisIntent {
  schema: "pi-bio.analysis_intent.v1";
  id: string;
  userText: string;
  capabilityId?: string;
  slots?: Record<string, unknown>;
  unresolved?: string[];
  defaultsApplied?: Record<string, unknown>;
}

export interface WorkflowState {
  kind: "workflow_state";
  schema: string;
  stateId: string;
  lifecycle: "ready" | "busy" | "waiting" | "disabled" | "error" | "expired";
  label?: string;
  description?: string;
  artifacts?: BioArtifact[];
  suggestedActions?: Array<{
    actionId: string;
    label: string;
    request: Record<string, unknown>;
    requiresConfirmation?: boolean;
    expectedArtifacts?: string[];
  }>;
}
