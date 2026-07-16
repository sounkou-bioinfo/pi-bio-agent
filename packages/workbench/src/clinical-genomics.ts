import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalDigest,
  fsCasStore,
  inTransaction,
  openBioStore,
  readJobStepCheckpoint,
  recordArtifactReference,
  recordMonotonicObservation,
  recordObservation,
  recordObservationLink,
  runBioOperationFromManifest,
  runBioQueryFromManifest,
  runJobStepsWithCheckpoints,
  validateContentAddress,
  type BioManifest,
  type CasStore,
  type ContentAddress,
  type HostCapabilityReceipt,
  type JsonValue,
  type RunCasRefs,
  type SqlConn,
} from "pi-bio-agent";
import {
  narrativeDigest,
  runPhenotypeGrounding,
  type GroundingMode,
  type GroundingRuntime,
  type OntologyCandidate,
  type PhenotypeGroundingResult,
} from "./phenotype-grounding.js";
import type { PhenotypeHypothesisRuntime } from "./monarch-host.js";
import {
  buildCandidateVariantSearchManifest,
  type CandidateIntervalRow,
  type CandidateVariantSearchRuntime,
} from "./candidate-variant-search.js";
import {
  getClinicalCaseRevisionRecord,
  type ClinicalCaseAsset,
  type ClinicalCaseRevision,
  type ClinicalCaseRevisionSummary,
} from "./clinical-case-registry.js";

export const EVIDENCE_PACKET_SCHEMA = "pi-bio.workbench.evidence_packet.v1" as const;
export const CLINICAL_ANALYSIS_SCHEMA = "pi-bio.workbench.clinical_analysis.v1" as const;

const SOURCE = "pi-bio-workbench:clinical-genomics";
const WORKFLOW_VERSION = "clinical-evidence-workflow.v6";
const PACKET_MEDIA_TYPE = "application/vnd.pi-bio.workbench.evidence+json";
const PACKET_STEP = "packet";
const AS_OF = "9999-12-31T23:59:59.999Z";
const CLINICAL_REVIEW_SCHEMA = "pi-bio.workbench.clinical_review.v1" as const;

type JsonRecord = { [key: string]: JsonValue };

export interface RunClinicalGenomicsRequest {
  /** Host-owned directory containing manifest.json and data/. */
  exampleDir: string;
  caseId: string;
  /** Immutable registered input revision. Omit only for legacy manifest-backed fixtures. */
  caseRevisionId?: string;
  /** Reuse this id to resume the same task. A new id starts a fresh analysis. */
  analysisId?: string;
  now?: string;
  /** Host-owned model/human composition. The application does not import a model SDK. */
  grounding: GroundingRuntime;
  /** Host-owned graph attachment and manifest composition for phenotype-to-gene hypotheses. */
  hypotheses: PhenotypeHypothesisRuntime;
  /** Host-owned assembly, interval snapshot, indexed case VCF, and DuckHTS provisioning. */
  variantSearch: CandidateVariantSearchRuntime;
  /** Host-owned VEP endpoint/profile and DuckNNG provisioning for selected candidate alleles. */
  vep: VepAnnotationRuntime;
}

export interface VepAnnotationRuntime {
  url: string;
  headersJson: string;
  profileId?: string;
  sourceId: string;
  sourceVersion: string;
  duckdbInitSql: string[];
  hostCapabilityReceipts?: readonly HostCapabilityReceipt[];
}

/** Default CLI/server composition; library callers should inject their own endpoint and host policy. */
export function defaultVepAnnotationRuntime(): VepAnnotationRuntime {
  const url = process.env.PI_BIO_VEP_URL ?? "https://rest.ensembl.org/vep/human/region";
  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new Error("PI_BIO_VEP_URL must use http or https");
  return {
    url,
    headersJson: process.env.PI_BIO_VEP_HEADERS_JSON ?? "[{\"name\":\"Content-Type\",\"value\":\"application/json\"},{\"name\":\"Accept\",\"value\":\"application/json\"}]",
    ...(process.env.PI_BIO_VEP_PROFILE_ID ? { profileId: process.env.PI_BIO_VEP_PROFILE_ID } : {}),
    sourceId: process.env.PI_BIO_VEP_SOURCE_ID ?? "https://rest.ensembl.org/vep/human/region",
    sourceVersion: process.env.PI_BIO_VEP_SOURCE_VERSION ?? "live",
    duckdbInitSql: [
      "LOAD ducknng",
      protocol === "https:"
        ? "SET VARIABLE vep_tls_config_id = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)"
        : "SET VARIABLE vep_tls_config_id = 0",
    ],
  };
}

export type OperationRows = {
  operationId: string;
  runId: string;
  rows: JsonRecord[];
  casRefs?: RunCasRefs;
};

export type ReviewItem = {
  kind: string;
  target: string;
  reason: string;
};

export type EvidencePacket = {
  schema: typeof EVIDENCE_PACKET_SCHEMA;
  analysisId: string;
  caseId: string;
  generatedAt: string;
  inputRevision?: {
    revisionId: string;
    revisionDigest: string;
    revisionUri: string;
  };
  stages: {
    hypotheses: OperationRows;
    intervals: OperationRows;
    variantSearch: OperationRows;
    annotationAudit: OperationRows;
    reanalysis: OperationRows;
  };
  lanes: {
    direct: OperationRows;
    inverted: OperationRows;
  };
  grounding: {
    groundingId: string;
    mode: GroundingMode;
    resultDigest: string;
    resultUri: string;
    sourceDigest: string;
    acceptedCount: number;
    rejectedCount: number;
  };
  summary: {
    directCandidates: number;
    directAbstentions: number;
    phenotypeHypotheses: number;
    resolvedCandidateGenes: number;
    unresolvedCandidateGenes: number;
    searchedCandidateGenes: number;
    unsearchedCandidateGenes: number;
    selectedAlleles: number;
    invertedSupportedHypotheses: number;
    invertedGaps: number;
    invertedUnsearched: number;
    conflicts: number;
    reanalysisSignals: number;
    reviewQueue: ReviewItem[];
    kernelScope: string;
  };
  provenance: {
    runIds: string[];
  };
};

export type EvidencePacketRef = {
  packetDigest: string;
  packetUri: string;
};

type PacketCheckpoint = EvidencePacketRef & {
  schema: "pi-bio.workbench.packet_checkpoint.v1";
};

type OperationCheckpoint = {
  schema: "pi-bio.workbench.operation_checkpoint.v1";
  operationId: string;
  runId: string;
  resultDigest: string;
  casRefs: RunCasRefs;
};

type GroundingCheckpoint = {
  schema: "pi-bio.workbench.grounding_checkpoint.v1";
  groundingId: string;
  resultDigest: string;
  resultUri: string;
  acceptedCount: number;
  rejectedCount: number;
  mode: GroundingMode;
  sourceDigest: string;
  queryRunIds: string[];
};

type GroundingArtifact = {
  schema: "pi-bio.workbench.grounding_artifact.v1";
  contractDigest: string;
  narrativeQuery: { runId: string; resultDigest: string };
  result: PhenotypeGroundingResult;
};

type ResolvedClinicalCaseInput = {
  revision: ClinicalCaseRevision;
  summary: ClinicalCaseRevisionSummary;
  narrative: { text: string; digest: string; assetId: string };
  manifest: BioManifest;
  variantSearch: CandidateVariantSearchRuntime;
};

export interface RunClinicalGenomicsResult extends EvidencePacketRef {
  analysisId: string;
  packet: EvidencePacket;
  workflow: {
    replayDigest: string;
    executedSteps: number;
    reusedSteps: number;
  };
  analysisDbPath: string;
  storePath: string;
}

export type ClinicalAnalysisStatus =
  | { found: false; analysisId: string }
  | ({ found: true; analysisId: string; packet: EvidencePacket } & EvidencePacketRef);

export interface ClinicalAnalysisSummary extends EvidencePacketRef {
  analysisId: string;
  caseId: string;
  generatedAt: string;
  recordedAt: string;
  reviewItems: number;
  directCandidates: number;
  directAbstentions: number;
  conflicts: number;
  reanalysisSignals: number;
}

export type ClinicalReviewDisposition = "open" | "acknowledged" | "needs_follow_up";

export interface ClinicalReviewQueueItem extends ReviewItem {
  reviewId: string;
  status: ClinicalReviewDisposition;
  note: string | null;
  updatedAt: string | null;
}

export type ClinicalReviewQueueStatus =
  | { found: false; analysisId: string }
  | {
    found: true;
    analysisId: string;
    caseId: string;
    packetDigest: string;
    reviews: ClinicalReviewQueueItem[];
  };

export interface UpdateClinicalReviewDispositionRequest {
  reviewId: string;
  status: ClinicalReviewDisposition;
  note?: string;
  now?: string;
}

/** A caller selected a review slot that is not part of the immutable evidence packet. */
export class ClinicalReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClinicalReviewInputError";
  }
}

export type ClinicalReanalysisQueueState =
  | "needs_follow_up"
  | "reanalysis_signal"
  | "evidence_conflict"
  | "evidence_gap"
  | "review_pending"
  | "no_active_signal";

export interface ClinicalReanalysisChange {
  variantKey: string;
  priorStatus: string | null;
  currentStatus: string | null;
  changeStatus: string;
}

export interface ClinicalReanalysisQueueEntry extends ClinicalAnalysisSummary {
  groundingId: string;
  runIds: string[];
  state: ClinicalReanalysisQueueState;
  reasons: string[];
  changes: ClinicalReanalysisChange[];
  openReviewItems: number;
  needsFollowUpItems: number;
  evidenceGaps: number;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)), "utf8");
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(encodeJson(value).toString("utf8")) as JsonValue;
}

function contentAddress(digest: string): ContentAddress {
  const [algorithm, value, extra] = digest.split(":");
  const address = { algorithm: algorithm as ContentAddress["algorithm"], digest: value ?? "" };
  const errors = extra === undefined ? validateContentAddress(address) : ["digest contains extra fields"];
  if (errors.length) throw new Error(`invalid CAS digest '${digest}': ${errors.join("; ")}`);
  return address;
}

const EMPTY_CASE_NARRATIVES_SQL = `SELECT NULL::VARCHAR AS case_id, NULL::VARCHAR AS narrative WHERE FALSE`;
const EMPTY_CASE_VARIANTS_SQL = `SELECT
  NULL::VARCHAR AS case_id,
  NULL::VARCHAR AS variant_key,
  NULL::VARCHAR AS gene,
  NULL::VARCHAR AS consequence,
  NULL::VARCHAR AS allele_frequency,
  NULL::VARCHAR AS clinical_significance,
  NULL::VARCHAR AS zygosity,
  NULL::VARCHAR AS inheritance
WHERE FALSE`;
const EMPTY_PRIOR_ASSESSMENT_SQL = `SELECT
  NULL::VARCHAR AS case_id,
  NULL::VARCHAR AS variant_key,
  NULL::VARCHAR AS prior_status
WHERE FALSE`;

function assetsOfKind(revision: ClinicalCaseRevision, kind: string): ClinicalCaseAsset[] {
  return revision.assets.filter((asset) => asset.kind === kind);
}

function optionalSingleAsset(revision: ClinicalCaseRevision, kind: string): ClinicalCaseAsset | undefined {
  const assets = assetsOfKind(revision, kind);
  if (assets.length > 1) throw new Error(`case revision '${revision.revisionId}' has ${assets.length} '${kind}' assets; this composition requires at most one`);
  return assets[0];
}

function requiredSingleAsset(revision: ClinicalCaseRevision, kind: string): ClinicalCaseAsset {
  const asset = optionalSingleAsset(revision, kind);
  if (!asset) throw new Error(`case revision '${revision.revisionId}' requires one '${kind}' asset`);
  return asset;
}

function tabularReader(asset: ClinicalCaseAsset): "csv" | "tsv" | "parquet" | "json" {
  const format = asset.format?.trim().toLowerCase();
  if (format === "csv" || format === "tsv" || format === "parquet" || format === "json") return format;
  if (format === "jsonl" || format === "ndjson") return "json";
  throw new Error(`case asset '${asset.assetId}' requires format csv, tsv, parquet, json, jsonl, or ndjson`);
}

function replaceResourceWithSql(manifest: BioManifest, resourceId: string, table: string, sql: string): void {
  const resource = manifest.provides?.resources?.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`clinical manifest has no '${resourceId}' resource`);
  resource.resolver = "duckdb.sql_materialize";
  resource.params = { table, sql };
}

function replaceResourceWithCasFile(
  manifest: BioManifest,
  cas: CasStore,
  resourceId: string,
  table: string,
  asset: ClinicalCaseAsset,
): void {
  const resource = manifest.provides?.resources?.find((candidate) => candidate.id === resourceId);
  if (!resource) throw new Error(`clinical manifest has no '${resourceId}' resource`);
  resource.resolver = "duckdb.file_scan";
  resource.params = {
    path: cas.pathFor(contentAddress(asset.digest)),
    table,
    reader: tabularReader(asset),
  };
}

async function linkVerifiedCasAsset(cas: CasStore, asset: ClinicalCaseAsset, destination: string): Promise<void> {
  const address = contentAddress(asset.digest);
  if (!await cas.has(address)) throw new Error(`case asset '${asset.assetId}' is missing from CAS`);
  await fs.mkdir(dirname(destination), { recursive: true });
  try {
    await fs.link(cas.pathFor(address), destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const actualDigest = await digestFile(destination);
  if (actualDigest !== asset.digest) {
    throw new Error(`materialized case asset '${asset.assetId}' does not match its registered digest`);
  }
}

async function resolveRegisteredClinicalCaseInput(
  exampleDir: string,
  caseId: string,
  revisionId: string,
  baseVariantSearch: CandidateVariantSearchRuntime,
): Promise<ResolvedClinicalCaseInput> {
  const record = await getClinicalCaseRevisionRecord(exampleDir, caseId, revisionId);
  if (!record) throw new Error(`clinical case revision '${caseId}:${revisionId}' was not found`);
  const { revision, summary } = record;
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));

  // Grounding consumes one prepared, source-spannable narrative. Additional raw
  // documents remain separate CAS assets until a declared extraction step creates
  // a successor clinical_narrative revision.
  const narrativeAsset = requiredSingleAsset(revision, "clinical_narrative");
  if (!narrativeAsset.mediaType.startsWith("text/")) {
    throw new Error(`clinical narrative asset '${narrativeAsset.assetId}' must use a text/* media type`);
  }
  const narrativeBytes = await fs.readFile(cas.pathFor(contentAddress(narrativeAsset.digest)));
  const narrativeText = narrativeBytes.toString("utf8");
  if (!narrativeText.trim()) throw new Error(`clinical narrative asset '${narrativeAsset.assetId}' is empty`);
  if (narrativeDigest(narrativeText) !== narrativeAsset.digest) {
    throw new Error(`clinical narrative asset '${narrativeAsset.assetId}' failed its content-digest check`);
  }

  const variantAsset = requiredSingleAsset(revision, "variant_set");
  if (!variantAsset.assembly) throw new Error(`variant set '${variantAsset.assetId}' requires an assembly`);
  const variantFormat = variantAsset.format?.trim().toLowerCase();
  if (!variantFormat || !["vcf", "vcf.gz", "bcf"].includes(variantFormat)) {
    throw new Error(`variant set '${variantAsset.assetId}' requires format vcf, vcf.gz, or bcf`);
  }
  const matchingIndexes = assetsOfKind(revision, "variant_index").filter((asset) =>
    asset.attributes?.index_for === variantAsset.assetId
  );
  if (matchingIndexes.length !== 1) {
    throw new Error(`variant set '${variantAsset.assetId}' requires exactly one variant_index with attributes.index_for='${variantAsset.assetId}'`);
  }
  const indexAsset = matchingIndexes[0]!;
  const indexFormat = indexAsset.format?.trim().toLowerCase();
  if (indexFormat !== "tbi" && indexFormat !== "csi") {
    throw new Error(`variant index '${indexAsset.assetId}' requires format tbi or csi`);
  }
  if (variantFormat === "bcf" && indexFormat !== "csi") {
    throw new Error(`BCF variant set '${variantAsset.assetId}' requires a CSI index`);
  }
  const inputRoot = join(
    exampleDir,
    ".pi",
    "bio-agent",
    "case-inputs",
    summary.revisionDigest.slice("sha256:".length),
  );
  const variantPath = join(inputRoot, variantFormat === "bcf" ? "variants.bcf" : "variants.vcf.gz");
  await linkVerifiedCasAsset(cas, variantAsset, variantPath);
  await linkVerifiedCasAsset(cas, indexAsset, `${variantPath}.${indexFormat}`);

  const manifest = JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
  replaceResourceWithSql(manifest, "case_narratives", "case_narratives", EMPTY_CASE_NARRATIVES_SQL);
  const directVariants = optionalSingleAsset(revision, "variant_table");
  if (directVariants) replaceResourceWithCasFile(manifest, cas, "case_variants", "case_variants", directVariants);
  else replaceResourceWithSql(manifest, "case_variants", "case_variants", EMPTY_CASE_VARIANTS_SQL);
  const priorAssessment = optionalSingleAsset(revision, "prior_assessment");
  if (priorAssessment) replaceResourceWithCasFile(manifest, cas, "prior_assessment", "prior_assessment", priorAssessment);
  else replaceResourceWithSql(manifest, "prior_assessment", "prior_assessment", EMPTY_PRIOR_ASSESSMENT_SQL);

  return {
    revision,
    summary,
    narrative: { text: narrativeText, digest: narrativeAsset.digest, assetId: narrativeAsset.assetId },
    manifest,
    variantSearch: {
      ...baseVariantSearch,
      assembly: variantAsset.assembly,
      vcfPath: variantPath,
      sourceVersion: canonicalDigest({
        revisionDigest: summary.revisionDigest,
        variantAsset: variantAsset.digest,
        indexAsset: indexAsset.digest,
      }),
    },
  };
}

async function readCasJson(cas: CasStore, digest: string): Promise<JsonValue> {
  const address = contentAddress(digest);
  const bytes = await fs.readFile(cas.pathFor(address));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== address.digest.toLowerCase()) {
    throw new Error(`CAS digest mismatch: expected ${address.digest}, got ${actual}`);
  }
  return JSON.parse(bytes.toString("utf8")) as JsonValue;
}

function asRows(value: unknown): JsonRecord[] {
  const normalized = toJsonValue(value);
  if (!Array.isArray(normalized) || normalized.some((row) => row === null || Array.isArray(row) || typeof row !== "object")) {
    throw new Error("clinical operation returned rows that are not JSON objects");
  }
  return normalized as JsonRecord[];
}

function asString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

type RegisteredAnnotationVariant = {
  case_id: string;
  variant_id?: string;
  variant_key: string;
  assembly: string;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
};

function projectRegisteredAnnotationVariants(rows: JsonRecord[], caseId: string): RegisteredAnnotationVariant[] {
  const registered = new Map<string, RegisteredAnnotationVariant>();
  for (const row of rows) {
    if (row.record_kind !== "variant") continue;
    const variantKey = asString(row.variant_key);
    const assembly = asString(row.assembly);
    const chrom = asString(row.chrom).replace(/^chr/i, "");
    const pos = row.pos;
    const ref = asString(row.ref);
    const alt = asString(row.alt);
    if (!variantKey || !assembly || !chrom || typeof pos !== "number" || !Number.isInteger(pos) || pos < 1 || !ref || !alt) {
      throw new Error(`candidate variant '${variantKey || "<missing>"}' has no complete annotation identity`);
    }
    const candidate: RegisteredAnnotationVariant = {
      case_id: caseId,
      ...(typeof row.variant_id === "string" && row.variant_id ? { variant_id: row.variant_id } : {}),
      variant_key: variantKey,
      assembly,
      chrom,
      pos,
      ref,
      alt,
    };
    const previous = registered.get(variantKey);
    if (previous && canonicalDigest(previous) !== canonicalDigest(candidate)) {
      throw new Error(`candidate variant '${variantKey}' has conflicting annotation identities`);
    }
    registered.set(variantKey, candidate);
  }
  return [...registered.values()].sort((left, right) => left.variant_key.localeCompare(right.variant_key));
}

function reviewReason(kind: string, row: JsonRecord): string {
  const variant = asString(row.variant_key);
  const gene = asString(row.gene);
  switch (kind) {
    case "confirm_candidate":
      return `${variant} passed the declared variant screen and has curated pathogenicity evidence; confirmation remains review-bound.`;
    case "adjudicate_candidate":
      return `${variant} passed the declared variant screen without decisive curated pathogenicity evidence.`;
    case "resolve_frequency":
      return `${variant || gene} has no usable allele frequency and was not called rare.`;
    case "correlate_supported_hypothesis":
      return `${gene} has both phenotype and screened genotype support; their case-level fit requires review.`;
    case "review_missing_genotype_support":
      return `${gene} is phenotype-supported, but no supporting variant was found within the recorded search scope; this is missing genotype support, not evidence against the hypothesis.`;
    case "review_conflict":
      return `${variant || gene} has conflicting curated and predicted consequence evidence.`;
    case "reanalysis_signal":
      return `${variant} is ${asString(row.change_status)} relative to the prior assessment.`;
    default:
      return `${asString(row.evidence_key) || variant || gene} requires review.`;
  }
}

function buildReviewQueue(evidenceRows: JsonRecord[], reanalysisRows: JsonRecord[]): ReviewItem[] {
  const queue: ReviewItem[] = [];
  const seen = new Set<string>();
  const add = (kind: string, target: string, row: JsonRecord): void => {
    const key = `${kind}\u0000${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ kind, target, reason: reviewReason(kind, row) });
  };

  for (const row of evidenceRows) {
    const kind = asString(row.review_kind);
    const target = asString(row.review_target);
    if (kind && target) add(kind, target, row);
  }
  for (const row of reanalysisRows) {
    const isSignal = (row.change_status === "new" || row.change_status === "upgraded")
      && (row.current_status === "candidate_needs_review" || row.current_status === "curated_plp_candidate");
    if (isSignal) add("reanalysis_signal", `variant:${asString(row.variant_key)}`, row);
  }
  return queue;
}

function reviewId(item: ReviewItem): string {
  return createHash("sha256").update(JSON.stringify([item.kind, item.target, item.reason])).digest("hex");
}

function reviewStatementKey(analysisId: string, id: string): string {
  return `clinical-review:${analysisId}:${id}`;
}

function reviewNode(analysisId: string, id: string): string {
  return `review:${analysisId}:${id}`;
}

function currentReviewItem(args: {
  item: ReviewItem;
  analysisId: string;
  caseId: string;
  valueJson: string | null;
  recordedAt: string | null;
}): ClinicalReviewQueueItem {
  const id = reviewId(args.item);
  if (args.valueJson == null) {
    return { ...args.item, reviewId: id, status: "open", note: null, updatedAt: null };
  }
  const value = JSON.parse(args.valueJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`clinical review '${id}' has a non-object ledger value`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== CLINICAL_REVIEW_SCHEMA
    || record.analysis_id !== args.analysisId
    || record.case_id !== args.caseId
    || record.review_id !== id
    || record.kind !== args.item.kind
    || record.target !== args.item.target
  ) {
    throw new Error(`clinical review '${id}' does not match its recorded evidence item`);
  }
  const status = record.status;
  if (status !== "open" && status !== "acknowledged" && status !== "needs_follow_up") {
    throw new Error(`clinical review '${id}' has unsupported disposition '${String(status)}'`);
  }
  const note = record.note;
  if (note != null && typeof note !== "string") throw new Error(`clinical review '${id}' has a non-string note`);
  return {
    ...args.item,
    reviewId: id,
    status,
    note: note ?? null,
    updatedAt: args.recordedAt == null ? null : new Date(args.recordedAt).toISOString(),
  };
}

function lane(operation: OperationRows, laneId: "direct" | "inverted"): OperationRows {
  return { ...operation, rows: operation.rows.filter((row) => row.lane === laneId) };
}

function distinctCount(rows: JsonRecord[], status: string): number {
  return new Set(
    rows
      .filter((row) => row.evidence_status === status)
      .map((row) => asString(row.review_target) || asString(row.evidence_key)),
  ).size;
}

function distinctFieldCount(rows: JsonRecord[], field: string): number {
  return new Set(rows.map((row) => asString(row[field])).filter(Boolean)).size;
}

function buildPacket(args: {
  analysisId: string;
  caseId: string;
  generatedAt: string;
  caseInput?: ResolvedClinicalCaseInput;
  grounding: GroundingCheckpoint;
  hypotheses: OperationRows;
  intervals: OperationRows;
  variantSearch: OperationRows;
  vep: OperationRows;
  annotationAudit: OperationRows;
  evidence: OperationRows;
  reanalysis: OperationRows;
}): EvidencePacket {
  const direct = lane(args.evidence, "direct");
  const inverted = lane(args.evidence, "inverted");
  const reviewQueue = buildReviewQueue(args.evidence.rows, args.reanalysis.rows);
  return {
    schema: EVIDENCE_PACKET_SCHEMA,
    analysisId: args.analysisId,
    caseId: args.caseId,
    generatedAt: args.generatedAt,
    ...(args.caseInput ? {
      inputRevision: {
        revisionId: args.caseInput.revision.revisionId,
        revisionDigest: args.caseInput.summary.revisionDigest,
        revisionUri: args.caseInput.summary.revisionUri,
      },
    } : {}),
    stages: {
      hypotheses: args.hypotheses,
      intervals: args.intervals,
      variantSearch: args.variantSearch,
      annotationAudit: args.annotationAudit,
      reanalysis: args.reanalysis,
    },
    lanes: { direct, inverted },
    grounding: {
      groundingId: args.grounding.groundingId,
      mode: args.grounding.mode,
      resultDigest: args.grounding.resultDigest,
      resultUri: args.grounding.resultUri,
      sourceDigest: args.grounding.sourceDigest,
      acceptedCount: args.grounding.acceptedCount,
      rejectedCount: args.grounding.rejectedCount,
    },
    summary: {
      directCandidates: direct.rows.filter((row) => row.variant_bucket === "candidate").length,
      directAbstentions: direct.rows.filter((row) => asString(row.variant_bucket).startsWith("abstain_")).length,
      phenotypeHypotheses: args.hypotheses.rows.length,
      resolvedCandidateGenes: distinctFieldCount(args.intervals.rows.filter((row) => row.interval_status === "resolved"), "gene_id"),
      unresolvedCandidateGenes: distinctFieldCount(args.intervals.rows.filter((row) => row.interval_status !== "resolved"), "gene_id"),
      searchedCandidateGenes: distinctFieldCount(args.variantSearch.rows.filter((row) => row.record_kind === "coverage" && row.search_status === "completed"), "gene_id"),
      unsearchedCandidateGenes: distinctFieldCount(args.variantSearch.rows.filter((row) => row.record_kind === "coverage" && row.search_status !== "completed"), "gene_id"),
      selectedAlleles: distinctFieldCount(args.variantSearch.rows.filter((row) => row.record_kind === "variant"), "variant_key"),
      invertedSupportedHypotheses: distinctCount(inverted.rows, "genotype_supports_hypothesis"),
      invertedGaps: distinctCount(inverted.rows, "hypothesis_without_supporting_variant"),
      invertedUnsearched: distinctCount(inverted.rows, "hypothesis_not_searched"),
      conflicts: new Set(
        args.evidence.rows
          .filter((row) => row.conflict != null)
          .map((row) => asString(row.variant_key) || asString(row.review_target) || asString(row.evidence_key)),
      ).size,
      reanalysisSignals: args.reanalysis.rows.filter((row) =>
        (row.change_status === "new" || row.change_status === "upgraded")
        && (row.current_status === "candidate_needs_review" || row.current_status === "curated_plp_candidate")
      ).length,
      reviewQueue,
      kernelScope: "evidence routing only; not a complete clinical classification kernel",
    },
    provenance: {
      runIds: [
        ...args.grounding.queryRunIds,
        args.hypotheses.runId,
        args.intervals.runId,
        args.variantSearch.runId,
        args.vep.runId,
        args.annotationAudit.runId,
        args.evidence.runId,
        args.reanalysis.runId,
      ],
    },
  };
}

const PHENOTYPE_CANDIDATE_SQL = `WITH documents AS (
  SELECT lower(json_extract_string(value, '$.text')) AS text
  FROM json_each(CAST(getvariable('retrieval_documents_json') AS JSON))
), term_text AS (
  SELECT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest, label AS matched_text
  FROM hpo_terms
  UNION ALL
  SELECT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest, synonym AS matched_text
  FROM hpo_terms
  WHERE synonym IS NOT NULL
)
SELECT DISTINCT hpo_id, label, ontology_source, ontology_version, ontology_digest, matched_text
FROM term_text, documents
WHERE strpos(text, lower(matched_text)) > 0
ORDER BY hpo_id, matched_text`;

async function runGroundingQuery(args: {
  exampleDir: string;
  manifestSnapshot?: BioManifest;
  analysisDbPath: string;
  ledger: SqlConn;
  cas: CasStore;
  runId: string;
  now: string;
  sql: string;
  resources: string[];
  bindings: Record<string, unknown>;
}): Promise<{ rows: JsonRecord[]; runId: string; resultDigest: string }> {
  const response = await runBioQueryFromManifest({
    cwd: args.exampleDir,
    dbPath: args.analysisDbPath,
    ...(args.manifestSnapshot
      ? { manifestSnapshot: args.manifestSnapshot, manifestBaseDir: args.exampleDir }
      : { manifestPath: "manifest.json" }),
    sql: args.sql,
    resources: args.resources,
    runId: args.runId,
    now: args.now,
    store: args.ledger,
    author: SOURCE,
    cas: args.cas,
    casMetadata: { conn: args.ledger },
    serialize: false,
    bindings: args.bindings,
  });
  if (!response.ok) throw new Error(`grounding query '${args.runId}' failed: ${response.error}`);
  if (!response.casRefs?.result) throw new Error(`grounding query '${args.runId}' completed without a CAS result digest`);
  return { rows: asRows(response.result.rows), runId: response.runId, resultDigest: response.casRefs.result };
}

function ontologyCandidates(rows: JsonRecord[]): OntologyCandidate[] {
  const byId = new Map<string, OntologyCandidate>();
  for (const row of rows) {
    const id = asString(row.hpo_id);
    const label = asString(row.label);
    const matchedText = asString(row.matched_text);
    const ontologyDigest = asString(row.ontology_digest);
    if (!id || !label || !matchedText || !ontologyDigest) throw new Error("candidate query returned an incomplete ontology row");
    const existing = byId.get(id);
    if (existing) {
      if (existing.label !== label || existing.ontologyDigest !== ontologyDigest) throw new Error(`inconsistent ontology rows for '${id}'`);
      if (!existing.matchedTexts.includes(matchedText)) existing.matchedTexts.push(matchedText);
      continue;
    }
    byId.set(id, {
      id,
      label,
      matchedTexts: [matchedText],
      ontologySource: asString(row.ontology_source),
      ontologyVersion: asString(row.ontology_version),
      ontologyDigest,
    });
  }
  return [...byId.values()];
}

async function runGrounding(args: {
  exampleDir: string;
  manifestSnapshot?: BioManifest;
  analysisDbPath: string;
  ledger: SqlConn;
  cas: CasStore;
  caseId: string;
  analysisId: string;
  now: string;
  composition: GroundingRuntime;
  caseInput?: ResolvedClinicalCaseInput;
}): Promise<GroundingCheckpoint> {
  const caseInput = args.caseInput;
  const narrativeQuery = caseInput
    ? await (async () => {
      const checkpoint = await runOperation({
        exampleDir: args.exampleDir,
        manifestSnapshot: args.manifestSnapshot,
        manifestBaseDir: args.exampleDir,
        conn: args.ledger,
        cas: args.cas,
        caseId: args.caseId,
        operationId: "clinical.registered_case_narrative",
        runId: `${args.analysisId}.grounding.narrative`,
        now: args.now,
        dbPath: args.analysisDbPath,
        protectedBindings: { case_narrative_text: caseInput.narrative.text },
      });
      const result = await readOperationRows(args.cas, checkpoint);
      return { rows: result.rows, runId: result.runId, resultDigest: checkpoint.resultDigest };
    })()
    : await runGroundingQuery({
      ...args,
      runId: `${args.analysisId}.grounding.narrative`,
      sql: "SELECT narrative FROM case_narratives WHERE case_id = getvariable('case_id')",
      resources: ["case_narratives"],
      bindings: { case_id: args.caseId },
    });
  if (narrativeQuery.rows.length !== 1) throw new Error(`expected one immutable narrative for case '${args.caseId}'`);
  const narrative = asString(narrativeQuery.rows[0]?.narrative);
  if (!narrative) throw new Error(`case '${args.caseId}' has an empty narrative`);
  if (caseInput && narrativeDigest(narrative) !== caseInput.narrative.digest) {
    throw new Error(`case '${args.caseId}' narrative query drifted from registered asset '${caseInput.narrative.assetId}'`);
  }
  const retrievalQueryRunIds: string[] = [];
  const result = await runPhenotypeGrounding({
    narrative: { caseId: args.caseId, text: narrative, sourceDigest: narrativeDigest(narrative) },
    mode: args.composition.mode,
    retriever: {
      async retrieve(input) {
        const query = await runGroundingQuery({
          ...args,
          runId: `${args.analysisId}.grounding.retrieve-${input.pass}`,
          sql: PHENOTYPE_CANDIDATE_SQL,
          resources: ["hpo_terms"],
          bindings: { retrieval_documents_json: JSON.stringify(input.documents) },
        });
        retrievalQueryRunIds.push(query.runId);
        return { candidates: ontologyCandidates(query.rows), runId: query.runId, resultDigest: query.resultDigest };
      },
    },
    agent: args.composition.agent,
    reviewer: args.composition.reviewer,
    ...(args.composition.augmenter ? { augmenter: args.composition.augmenter } : {}),
  });
  const artifact: GroundingArtifact = {
    schema: "pi-bio.workbench.grounding_artifact.v1",
    contractDigest: args.composition.contractDigest,
    narrativeQuery: { runId: narrativeQuery.runId, resultDigest: narrativeQuery.resultDigest },
    result,
  };
  const bytes = encodeJson(artifact);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const resultDigest = `sha256:${hash}`;
  const resultUri = `cas:${resultDigest}`;
  await args.cas.put({ algorithm: "sha256", digest: hash, sizeBytes: bytes.length, mediaType: "application/vnd.pi-bio.workbench.phenotype-grounding+json" }, bytes);
  const groundingId = `grounding:${args.analysisId}`;
  await recordObservation(args.ledger, {
    statementKey: groundingId,
    subjectId: groundingId,
    predicate: "grounding",
    value: {
      schema: "pi-bio.workbench.grounding.v1",
      status: "succeeded",
      case_id: args.caseId,
      mode: result.mode,
      narrative_digest: result.sourceDigest,
      ontology_digests: [...new Set(result.candidates.map((candidate) => candidate.ontologyDigest))],
      result_digest: resultDigest,
      accepted_count: result.accepted.length,
      rejected_count: result.rejected.length,
    },
    recordedAt: args.now,
    source: SOURCE,
    digest: resultDigest,
  });
  await recordArtifactReference(args.ledger, {
    artifact: {
      digest: resultDigest as `sha256:${string}`,
      mediaType: "application/vnd.pi-bio.workbench.phenotype-grounding+json",
      semanticRole: "phenotype_grounding",
      sizeBytes: bytes.length,
      attrs: { case_id: args.caseId, analysis_id: args.analysisId },
    },
    subjectId: groundingId,
    predicate: "produces",
    recordedAt: args.now,
    source: SOURCE,
    digest: resultDigest,
    casMetadata: { conn: args.ledger, refId: groundingId, refType: "artifact" },
  });
  await recordObservationLink(args.ledger, {
    subjectId: `case:${args.caseId}`,
    predicate: "has_grounding",
    objectId: groundingId,
    recordedAt: args.now,
    source: SOURCE,
    digest: resultDigest,
  });
  if (caseInput) {
    await recordObservationLink(args.ledger, {
      subjectId: groundingId,
      predicate: "uses_case_revision",
      objectId: `case-revision:${args.caseId}:${caseInput.revision.revisionId}`,
      recordedAt: args.now,
      source: SOURCE,
      digest: caseInput.summary.revisionDigest,
    });
  }
  const queryRunIds = [narrativeQuery.runId, ...retrievalQueryRunIds];
  for (const queryRunId of queryRunIds) {
    await recordObservationLink(args.ledger, {
      subjectId: groundingId,
      predicate: "uses_run",
      objectId: `run:${queryRunId}`,
      recordedAt: args.now,
      source: SOURCE,
      digest: resultDigest,
    });
  }
  return {
    schema: "pi-bio.workbench.grounding_checkpoint.v1",
    groundingId,
    resultDigest,
    resultUri,
    acceptedCount: result.accepted.length,
    rejectedCount: result.rejected.length,
    mode: result.mode,
    sourceDigest: result.sourceDigest,
    queryRunIds,
  };
}

async function runOperation(args: {
  exampleDir: string;
  manifestPath?: string;
  manifestSnapshot?: BioManifest;
  manifestBaseDir?: string;
  conn: SqlConn;
  cas: CasStore;
  caseId: string;
  operationId: string;
  runId: string;
  now: string;
  dbPath: string;
  duckdbInitSql?: string[];
  bindings?: Record<string, unknown>;
  protectedBindings?: Record<string, unknown>;
  protectedVariables?: readonly string[];
  hostCapabilityReceipts?: readonly HostCapabilityReceipt[];
}): Promise<OperationCheckpoint> {
  const response = await runBioOperationFromManifest({
    cwd: args.exampleDir,
    dbPath: args.dbPath,
    ...(args.manifestSnapshot
      ? { manifestSnapshot: args.manifestSnapshot, manifestBaseDir: args.manifestBaseDir ?? args.exampleDir }
      : { manifestPath: args.manifestPath ?? "manifest.json" }),
    operationId: args.operationId,
    runId: args.runId,
    now: args.now,
    store: args.conn,
    author: SOURCE,
    cas: args.cas,
    casMetadata: { conn: args.conn },
    serialize: false,
    ...(args.duckdbInitSql ? { duckdbInitSql: args.duckdbInitSql } : {}),
    bindings: { case_id: args.caseId, ...args.bindings },
    ...(args.protectedBindings || args.protectedVariables ? {
      protectedSessionBindings: args.protectedBindings,
      protectedSessionVariables: [...new Set([
        ...Object.keys(args.protectedBindings ?? {}),
        ...(args.protectedVariables ?? []),
      ])],
    } : {}),
    ...(args.hostCapabilityReceipts ? { hostCapabilityReceipts: args.hostCapabilityReceipts } : {}),
  });
  if (!response.ok) throw new Error(`${args.operationId} failed: ${response.error}`);
  if (!response.casRefs?.result) throw new Error(`${args.operationId} completed without a CAS result digest`);
  return {
    schema: "pi-bio.workbench.operation_checkpoint.v1",
    operationId: args.operationId,
    runId: response.runId,
    resultDigest: response.casRefs.result,
    casRefs: response.casRefs,
  };
}

async function readOperationRows(cas: CasStore, checkpoint: OperationCheckpoint): Promise<OperationRows> {
  return {
    operationId: checkpoint.operationId,
    runId: checkpoint.runId,
    rows: asRows(await readCasJson(cas, checkpoint.resultDigest)),
    casRefs: checkpoint.casRefs,
  };
}

async function recordPacket(args: {
  conn: SqlConn;
  cas: CasStore;
  packet: EvidencePacket;
  recordedAt: string;
}): Promise<PacketCheckpoint> {
  const bytes = encodeJson(args.packet);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const packetDigest = `sha256:${digest}`;
  const packetUri = `cas:${packetDigest}`;
  await args.cas.put({ algorithm: "sha256", digest, sizeBytes: bytes.length, mediaType: PACKET_MEDIA_TYPE }, bytes);

  const caseNode = `case:${args.packet.caseId}`;
  const analysisNode = `analysis:${args.packet.analysisId}`;
  await recordObservation(args.conn, {
    statementKey: analysisNode,
    subjectId: analysisNode,
    predicate: "analysis",
    value: {
      schema: CLINICAL_ANALYSIS_SCHEMA,
      status: "succeeded",
      case_id: args.packet.caseId,
      packet_digest: packetDigest,
      packet_uri: packetUri,
      review_items: args.packet.summary.reviewQueue.length,
      case_revision_id: args.packet.inputRevision?.revisionId ?? null,
      case_revision_digest: args.packet.inputRevision?.revisionDigest ?? null,
    },
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
  });
  await recordObservation(args.conn, {
    statementKey: packetUri,
    subjectId: packetUri,
    predicate: "artifact",
    value: {
      digest: packetDigest,
      uri: packetUri,
      media_type: PACKET_MEDIA_TYPE,
      semantic_role: "evidence_packet",
      size_bytes: bytes.length,
    },
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
    attrs: { case_id: args.packet.caseId, analysis_id: args.packet.analysisId },
  });
  await recordObservationLink(args.conn, {
    subjectId: caseNode,
    predicate: "has_analysis",
    objectId: analysisNode,
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
  });
  if (args.packet.inputRevision) {
    const revisionNode = `case-revision:${args.packet.caseId}:${args.packet.inputRevision.revisionId}`;
    await recordObservationLink(args.conn, {
      subjectId: analysisNode,
      predicate: "uses_case_revision",
      objectId: revisionNode,
      recordedAt: args.recordedAt,
      source: SOURCE,
      digest: args.packet.inputRevision.revisionDigest,
    });
    await recordObservationLink(args.conn, {
      subjectId: packetUri,
      predicate: "derived_from",
      objectId: args.packet.inputRevision.revisionUri,
      recordedAt: args.recordedAt,
      source: SOURCE,
      digest: args.packet.inputRevision.revisionDigest,
    });
  }
  await recordObservationLink(args.conn, {
    subjectId: analysisNode,
    predicate: "produces",
    objectId: packetUri,
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
    attrs: { semantic_role: "evidence_packet" },
  });
  await recordObservationLink(args.conn, {
    subjectId: analysisNode,
    predicate: "uses_grounding",
    objectId: args.packet.grounding.groundingId,
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
  });
  await recordObservationLink(args.conn, {
    subjectId: packetUri,
    predicate: "derived_from",
    objectId: args.packet.grounding.resultUri,
    recordedAt: args.recordedAt,
    source: SOURCE,
    digest: packetDigest,
  });
  for (const runId of args.packet.provenance.runIds) {
    await recordObservationLink(args.conn, {
      subjectId: analysisNode,
      predicate: "uses_run",
      objectId: `run:${runId}`,
      recordedAt: args.recordedAt,
      source: SOURCE,
      digest: packetDigest,
    });
    await recordObservationLink(args.conn, {
      subjectId: packetUri,
      predicate: "derived_from",
      objectId: `run:${runId}`,
      recordedAt: args.recordedAt,
      source: SOURCE,
      digest: packetDigest,
    });
  }
  return { schema: "pi-bio.workbench.packet_checkpoint.v1", packetDigest, packetUri };
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function workflowReplayDigest(
  exampleDir: string,
  caseId: string,
  grounding: GroundingRuntime,
  hypotheses: PhenotypeHypothesisRuntime,
  variantSearch: CandidateVariantSearchRuntime,
  vep: VepAnnotationRuntime,
  caseInput?: ResolvedClinicalCaseInput,
): Promise<string> {
  const manifest = caseInput?.manifest
    ?? JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
  const hypothesisManifestPath = isAbsolute(hypotheses.manifestPath)
    ? hypotheses.manifestPath
    : resolve(exampleDir, hypotheses.manifestPath);
  const hypothesisManifest = JSON.parse(await fs.readFile(hypothesisManifestPath, "utf8")) as BioManifest;
  const intervalManifestPath = isAbsolute(variantSearch.intervalManifestPath)
    ? variantSearch.intervalManifestPath
    : resolve(variantSearch.manifestBaseDir, variantSearch.intervalManifestPath);
  const intervalManifest = JSON.parse(await fs.readFile(intervalManifestPath, "utf8")) as BioManifest;
  const variantSearchManifestPath = isAbsolute(variantSearch.variantSearchManifestPath)
    ? variantSearch.variantSearchManifestPath
    : resolve(variantSearch.manifestBaseDir, variantSearch.variantSearchManifestPath);
  const variantSearchManifest = JSON.parse(await fs.readFile(variantSearchManifestPath, "utf8")) as BioManifest;
  const inputPaths = new Map<string, string>();
  for (const resource of manifest.provides?.resources ?? []) {
    if (resource.resolver === "duckdb.file_scan" && typeof resource.params.path === "string") {
      inputPaths.set(`clinical:${resource.id}`, resolve(exampleDir, resource.params.path));
    }
  }
  for (const resource of hypothesisManifest.provides?.resources ?? []) {
    const sources = Array.isArray(resource.params.declaredSources) ? resource.params.declaredSources : [];
    for (const source of sources) {
      if (typeof source !== "string" || !source.startsWith("file:")) continue;
      const path = source.slice("file:".length);
      inputPaths.set(`hypotheses:${source}`, isAbsolute(path) ? path : resolve(dirname(hypothesisManifestPath), path));
    }
  }
  for (const resource of intervalManifest.provides?.resources ?? []) {
    if (resource.resolver === "duckdb.file_scan" && typeof resource.params.path === "string") {
      inputPaths.set(`intervals:${resource.id}`, resolve(dirname(intervalManifestPath), resource.params.path));
    }
  }
  const inputs = await Promise.all([...inputPaths].map(async ([resourceId, path]) => ({ resourceId, digest: await digestFile(path) })));
  inputs.sort((left, right) => left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0);
  return canonicalDigest({
    schema: WORKFLOW_VERSION,
    caseId,
    caseRevision: caseInput ? {
      revisionId: caseInput.revision.revisionId,
      revisionDigest: caseInput.summary.revisionDigest,
      assetDigests: caseInput.revision.assets.map((asset) => ({ assetId: asset.assetId, digest: asset.digest })),
    } : null,
    manifest,
    inputs,
    grounding: {
      mode: grounding.mode,
      contractDigest: grounding.contractDigest,
      agent: grounding.agent.identity,
      reviewer: grounding.reviewer.identity,
      augmenter: grounding.augmenter?.identity ?? null,
    },
    hypotheses: {
      manifest: hypothesisManifest,
      operationId: hypotheses.operationId,
      limit: hypotheses.limit,
      duckdbInitSqlDigest: canonicalDigest(hypotheses.duckdbInitSql),
    },
    variantSearch: {
      assembly: variantSearch.assembly,
      intervalManifest,
      intervalOperationId: variantSearch.intervalOperationId,
      manifest: variantSearchManifest,
      operationId: variantSearch.variantSearchOperationId,
      sourceVersion: variantSearch.sourceVersion,
      duckdbInitSqlDigest: canonicalDigest(variantSearch.duckdbInitSql),
    },
    vep: {
      sourceId: vep.sourceId,
      sourceVersion: vep.sourceVersion,
      urlDigest: canonicalDigest(vep.url),
      headersDigest: canonicalDigest(vep.headersJson),
      duckdbInitSqlDigest: canonicalDigest(vep.duckdbInitSql),
      hostCapabilityReceiptDigest: canonicalDigest(vep.hostCapabilityReceipts ?? []),
    },
  });
}

export async function runClinicalGenomicsWorkbench(req: RunClinicalGenomicsRequest): Promise<RunClinicalGenomicsResult> {
  const now = req.now ?? new Date().toISOString();
  const analysisId = req.analysisId ?? `clinical-${randomUUID()}`;
  const exampleDir = resolve(req.exampleDir);
  if (!req.grounding.contractDigest) throw new Error("grounding composition requires a contractDigest");
  if (!req.hypotheses?.manifestPath || !req.hypotheses.duckdbInitSql.length || !Number.isInteger(req.hypotheses.limit) || req.hypotheses.limit < 1) {
    throw new Error("phenotype hypothesis composition requires a manifest, DuckDB initialization, and a positive integer limit");
  }
  if (
    !req.variantSearch?.assembly
    || !req.variantSearch.intervalManifestPath
    || !req.variantSearch.variantSearchManifestPath
    || !req.variantSearch.manifestBaseDir
    || !req.variantSearch.vcfPath
    || !req.variantSearch.sourceVersion
    || !req.variantSearch.duckdbInitSql.length
  ) {
    throw new Error("candidate variant-search composition requires an assembly, manifests, source identity, indexed VCF, and DuckDB initialization");
  }
  if (!req.vep?.url || !req.vep.sourceId || !req.vep.sourceVersion || !req.vep.headersJson || !req.vep.duckdbInitSql.length) {
    throw new Error("VEP composition requires an endpoint, source identity, headers, and DuckDB initialization");
  }
  const caseInput = req.caseRevisionId
    ? await resolveRegisteredClinicalCaseInput(exampleDir, req.caseId, req.caseRevisionId, req.variantSearch)
    : undefined;
  const clinicalManifest = caseInput?.manifest
    ?? JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
  const variantSearchRuntime = caseInput?.variantSearch ?? req.variantSearch;
  const composition = req.grounding;
  const replayDigest = await workflowReplayDigest(
    exampleDir,
    req.caseId,
    composition,
    req.hypotheses,
    variantSearchRuntime,
    req.vep,
    caseInput,
  );
  const analysisDbDir = join(exampleDir, ".pi", "bio-agent", "analyses");
  const analysisDbPath = join(analysisDbDir, `${createHash("sha256").update(analysisId).digest("hex")}.duckdb`);
  await fs.mkdir(analysisDbDir, { recursive: true });
  const store = await openBioStore(exampleDir);
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  try {
    const workflow = await runJobStepsWithCheckpoints(store.conn, {
      runId: analysisId,
      recordedAt: now,
      replayDigest,
      source: SOURCE,
      steps: [
        {
          stepId: "phenotype-grounding",
          run: async () => toJsonValue(await runGrounding({
            exampleDir,
            manifestSnapshot: clinicalManifest,
            analysisDbPath,
            ledger: store.conn,
            cas,
            caseId: req.caseId,
            analysisId,
            now,
            composition,
            ...(caseInput ? { caseInput } : {}),
          })),
        },
        {
          stepId: "phenotype-hypotheses",
          run: async ({ valueOf }) => {
            const groundingCheckpoint = valueOf<JsonValue>("phenotype-grounding") as unknown as GroundingCheckpoint;
            const groundingArtifact = await readCasJson(cas, groundingCheckpoint.resultDigest) as unknown as GroundingArtifact;
            if (groundingArtifact.schema !== "pi-bio.workbench.grounding_artifact.v1") throw new Error("unsupported grounding artifact schema");
            const phenotypeIds = [...new Set(groundingArtifact.result.accepted
              .filter((observation) => observation.assertionContext === "present" && observation.subjectContext === "proband")
              .map((observation) => observation.hpoId))];
            return toJsonValue(await runOperation({
              exampleDir,
              manifestPath: req.hypotheses.manifestPath,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: req.hypotheses.operationId,
              runId: `${analysisId}.hypotheses`,
              now,
              dbPath: analysisDbPath,
              duckdbInitSql: req.hypotheses.duckdbInitSql,
              bindings: { phenotype_ids: phenotypeIds, limit: req.hypotheses.limit },
            }));
          },
        },
        {
          stepId: "candidate-gene-intervals",
          run: async ({ valueOf }) => {
            const hypothesisCheckpoint = valueOf<JsonValue>("phenotype-hypotheses") as unknown as OperationCheckpoint;
            const hypotheses = await readOperationRows(cas, hypothesisCheckpoint);
            const intervals = await runOperation({
              exampleDir,
              manifestPath: variantSearchRuntime.intervalManifestPath,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: variantSearchRuntime.intervalOperationId,
              runId: `${analysisId}.intervals`,
              now,
              dbPath: analysisDbPath,
              bindings: { assembly: variantSearchRuntime.assembly },
              protectedBindings: { hypotheses_json: JSON.stringify(hypotheses.rows) },
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${intervals.runId}`,
              predicate: "uses_run",
              objectId: `run:${hypothesisCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: intervals.resultDigest,
            });
            return toJsonValue(intervals);
          },
        },
        {
          stepId: "candidate-variant-search",
          run: async ({ valueOf }) => {
            const intervalCheckpoint = valueOf<JsonValue>("candidate-gene-intervals") as unknown as OperationCheckpoint;
            const intervals = await readOperationRows(cas, intervalCheckpoint);
            const templatePath = isAbsolute(variantSearchRuntime.variantSearchManifestPath)
              ? variantSearchRuntime.variantSearchManifestPath
              : resolve(variantSearchRuntime.manifestBaseDir, variantSearchRuntime.variantSearchManifestPath);
            const template = JSON.parse(await fs.readFile(templatePath, "utf8")) as BioManifest;
            const dynamic = buildCandidateVariantSearchManifest(
              template,
              intervals.rows as unknown as CandidateIntervalRow[],
              variantSearchRuntime,
            );
            const search = await runOperation({
              exampleDir,
              manifestSnapshot: dynamic.manifest,
              manifestBaseDir: variantSearchRuntime.manifestBaseDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: variantSearchRuntime.variantSearchOperationId,
              runId: `${analysisId}.variant-search`,
              now,
              dbPath: analysisDbPath,
              ...(dynamic.regions.length ? { duckdbInitSql: variantSearchRuntime.duckdbInitSql } : {}),
              protectedBindings: {
                intervals_json: JSON.stringify(intervals.rows),
                case_vcf_path: variantSearchRuntime.vcfPath.includes("://") || isAbsolute(variantSearchRuntime.vcfPath)
                  ? variantSearchRuntime.vcfPath
                  : resolve(variantSearchRuntime.manifestBaseDir, variantSearchRuntime.vcfPath),
              },
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${search.runId}`,
              predicate: "uses_run",
              objectId: `run:${intervalCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: search.resultDigest,
            });
            return toJsonValue(search);
          },
        },
        {
          stepId: "vep-annotation",
          run: async ({ valueOf }) => {
            const variantSearchCheckpoint = valueOf<JsonValue>("candidate-variant-search") as unknown as OperationCheckpoint;
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const selected = projectRegisteredAnnotationVariants(variantSearch.rows, req.caseId);
            const manifest = structuredClone(clinicalManifest);
            const httpResource = manifest.provides?.resources?.find((resource) => resource.id === "vep_http_results");
            if (!httpResource) throw new Error("clinical manifest has no vep_http_results resource");
            httpResource.params = {
              ...httpResource.params,
              declaredSources: [req.vep.sourceId],
              sourceVersion: req.vep.sourceVersion,
            };
            const annotation = await runOperation({
              exampleDir,
              manifestSnapshot: manifest,
              manifestBaseDir: exampleDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: "clinical.vep_annotations",
              runId: `${analysisId}.vep`,
              now,
              dbPath: analysisDbPath,
              duckdbInitSql: req.vep.duckdbInitSql,
              protectedBindings: {
                selected_variants_json: JSON.stringify(selected),
                vep_url: req.vep.url,
                vep_headers_json: req.vep.headersJson,
                vep_profile_id: req.vep.profileId ?? "",
                vep_source_id: req.vep.sourceId,
                vep_source_version: req.vep.sourceVersion,
                vep_source_uri: req.vep.url,
                vep_observed_at: now,
              },
              ...(req.vep.hostCapabilityReceipts ? { hostCapabilityReceipts: req.vep.hostCapabilityReceipts } : {}),
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${annotation.runId}`,
              predicate: "uses_run",
              objectId: `run:${variantSearchCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: annotation.resultDigest,
            });
            return toJsonValue(annotation);
          },
        },
        {
          stepId: "variant-annotation-audit",
          run: async ({ valueOf }) => {
            const variantSearchCheckpoint = valueOf<JsonValue>("candidate-variant-search") as unknown as OperationCheckpoint;
            const annotationCheckpoint = valueOf<JsonValue>("vep-annotation") as unknown as OperationCheckpoint;
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const annotations = await readOperationRows(cas, annotationCheckpoint);
            const registered = projectRegisteredAnnotationVariants(variantSearch.rows, req.caseId);
            const audit = await runOperation({
              exampleDir,
              manifestSnapshot: structuredClone(clinicalManifest),
              manifestBaseDir: exampleDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: "clinical.variant_annotation_audit",
              runId: `${analysisId}.annotation-audit`,
              now,
              dbPath: analysisDbPath,
              protectedBindings: {
                registered_annotation_variants_json: JSON.stringify(registered),
                variant_annotation_observations_json: JSON.stringify(annotations.rows),
              },
            });
            for (const dependencyRunId of [variantSearchCheckpoint.runId, annotationCheckpoint.runId]) {
              await recordObservationLink(store.conn, {
                subjectId: `run:${audit.runId}`,
                predicate: "uses_run",
                objectId: `run:${dependencyRunId}`,
                recordedAt: now,
                source: SOURCE,
                digest: audit.resultDigest,
              });
            }
            return toJsonValue(audit);
          },
        },
        {
          stepId: "reanalysis",
          run: async ({ valueOf }) => {
            const auditCheckpoint = valueOf<JsonValue>("variant-annotation-audit") as unknown as OperationCheckpoint;
            const auditRows = await readOperationRows(cas, auditCheckpoint);
            const reanalysis = await runOperation({
              exampleDir,
              manifestSnapshot: structuredClone(clinicalManifest),
              manifestBaseDir: exampleDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: "clinical.reanalysis_diff",
              runId: `${analysisId}.reanalysis`,
              now,
              dbPath: analysisDbPath,
              protectedBindings: {
                candidate_variant_search_json: "[]",
                variant_annotation_audit_json: JSON.stringify(auditRows.rows),
              },
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${reanalysis.runId}`,
              predicate: "uses_run",
              objectId: `run:${auditCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: reanalysis.resultDigest,
            });
            return toJsonValue(reanalysis);
          },
        },
        {
          stepId: "case-evidence",
          run: async ({ valueOf }) => {
            const hypothesisCheckpoint = valueOf<JsonValue>("phenotype-hypotheses") as unknown as OperationCheckpoint;
            const variantSearchCheckpoint = valueOf<JsonValue>("candidate-variant-search") as unknown as OperationCheckpoint;
            const auditCheckpoint = valueOf<JsonValue>("variant-annotation-audit") as unknown as OperationCheckpoint;
            const hypotheses = await readOperationRows(cas, hypothesisCheckpoint);
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const auditRows = await readOperationRows(cas, auditCheckpoint);
            const evidence = await runOperation({
              exampleDir,
              manifestSnapshot: structuredClone(clinicalManifest),
              manifestBaseDir: exampleDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: "clinical.case_evidence",
              runId: `${analysisId}.evidence`,
              now,
              dbPath: analysisDbPath,
              protectedBindings: {
                phenotype_hypotheses_json: JSON.stringify(hypotheses.rows),
                candidate_variant_search_json: JSON.stringify(variantSearch.rows),
                variant_annotation_audit_json: JSON.stringify(auditRows.rows),
              },
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${evidence.runId}`,
              predicate: "uses_run",
              objectId: `run:${hypothesisCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: evidence.resultDigest,
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${evidence.runId}`,
              predicate: "uses_run",
              objectId: `run:${variantSearchCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: evidence.resultDigest,
            });
            await recordObservationLink(store.conn, {
              subjectId: `run:${evidence.runId}`,
              predicate: "uses_run",
              objectId: `run:${auditCheckpoint.runId}`,
              recordedAt: now,
              source: SOURCE,
              digest: evidence.resultDigest,
            });
            return toJsonValue(evidence);
          },
        },
        {
          stepId: PACKET_STEP,
          run: async ({ valueOf }) => {
            const groundingCheckpoint = valueOf<JsonValue>("phenotype-grounding") as unknown as GroundingCheckpoint;
            const hypothesisCheckpoint = valueOf<JsonValue>("phenotype-hypotheses") as unknown as OperationCheckpoint;
            const intervalCheckpoint = valueOf<JsonValue>("candidate-gene-intervals") as unknown as OperationCheckpoint;
            const variantSearchCheckpoint = valueOf<JsonValue>("candidate-variant-search") as unknown as OperationCheckpoint;
            const annotationCheckpoint = valueOf<JsonValue>("vep-annotation") as unknown as OperationCheckpoint;
            const annotationAuditCheckpoint = valueOf<JsonValue>("variant-annotation-audit") as unknown as OperationCheckpoint;
            const evidenceCheckpoint = valueOf<JsonValue>("case-evidence") as unknown as OperationCheckpoint;
            const reanalysisCheckpoint = valueOf<JsonValue>("reanalysis") as unknown as OperationCheckpoint;
            const hypotheses = await readOperationRows(cas, hypothesisCheckpoint);
            const intervals = await readOperationRows(cas, intervalCheckpoint);
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const vep = await readOperationRows(cas, annotationCheckpoint);
            const annotationAudit = await readOperationRows(cas, annotationAuditCheckpoint);
            const evidence = await readOperationRows(cas, evidenceCheckpoint);
            const reanalysis = await readOperationRows(cas, reanalysisCheckpoint);
            const packet = buildPacket({
              analysisId,
              caseId: req.caseId,
              generatedAt: now,
              ...(caseInput ? { caseInput } : {}),
              grounding: groundingCheckpoint,
              hypotheses,
              intervals,
              variantSearch,
              vep,
              annotationAudit,
              evidence,
              reanalysis,
            });
            return toJsonValue(await recordPacket({ conn: store.conn, cas, packet, recordedAt: now }));
          },
        },
      ],
    });
    const checkpoint = workflow.steps.find((step) => step.stepId === PACKET_STEP)?.value as PacketCheckpoint | undefined;
    if (!checkpoint) throw new Error(`analysis '${analysisId}' completed without an evidence packet checkpoint`);
    const packet = await readEvidencePacket(exampleDir, checkpoint.packetDigest);
    return {
      analysisId,
      packet,
      packetDigest: checkpoint.packetDigest,
      packetUri: checkpoint.packetUri,
      workflow: {
        replayDigest,
        executedSteps: workflow.executed,
        reusedSteps: workflow.reused,
      },
      analysisDbPath,
      storePath: join(exampleDir, ".pi", "bio-agent", "store.duckdb"),
    };
  } finally {
    store.close();
  }
}

export async function getClinicalAnalysis(exampleDir: string, analysisId: string): Promise<ClinicalAnalysisStatus> {
  const store = await openBioStore(exampleDir);
  try {
    const checkpoint = await readJobStepCheckpoint<JsonValue>(store.conn, analysisId, PACKET_STEP);
    if (!checkpoint) return { found: false, analysisId };
    const value = checkpoint.value as unknown as PacketCheckpoint;
    const packet = await readEvidencePacket(exampleDir, value.packetDigest);
    return {
      found: true,
      analysisId,
      packet,
      packetDigest: value.packetDigest,
      packetUri: value.packetUri,
    };
  } finally {
    store.close();
  }
}

type ClinicalAnalysisListOptions = { caseId?: string; limit?: number };

type ClinicalAnalysisRecord = {
  summary: ClinicalAnalysisSummary;
  packet: EvidencePacket;
};

function clinicalAnalysisLimit(limit: number | undefined): number {
  const resolved = limit ?? 100;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 500) {
    throw new Error("clinical analysis limit must be an integer from 1 to 500");
  }
  return resolved;
}

async function listClinicalAnalysisRecords(
  exampleDir: string,
  options: ClinicalAnalysisListOptions,
  latestPerCase: boolean,
  maxRows: number | null = clinicalAnalysisLimit(options.limit),
): Promise<ClinicalAnalysisRecord[]> {
  const store = await openBioStore(exampleDir);
  try {
    const rows = await store.conn.all<{ subject_id: string; value_json: string | null; recorded_at: string }>(
      `WITH eligible AS (
         SELECT * FROM bio_observations
         WHERE predicate = 'analysis'
           AND starts_with(subject_id, 'analysis:')
           AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
           AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
           AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
       ), current AS (
         SELECT * EXCLUDE (rn) FROM (
           SELECT *, row_number() OVER (
             PARTITION BY statement_key
             ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC
           ) AS rn
           FROM eligible
         ) WHERE rn = 1
       ), succeeded AS (
         SELECT
           subject_id,
           value_json,
           recorded_at,
           json_extract_string(value_json, '$.case_id') AS case_id
         FROM current
         WHERE value_json IS NOT NULL
           AND json_extract_string(value_json, '$.schema') = ?
           AND json_extract_string(value_json, '$.status') = 'succeeded'
           AND (? IS NULL OR json_extract_string(value_json, '$.case_id') = ?)
       ), latest_by_case AS (
         SELECT * EXCLUDE (case_rn) FROM (
           SELECT *, row_number() OVER (
             PARTITION BY case_id
             ORDER BY recorded_at::TIMESTAMPTZ DESC, subject_id DESC
           ) AS case_rn
           FROM succeeded
         ) WHERE case_rn = 1
       )
       SELECT subject_id, value_json, recorded_at
       FROM ${latestPerCase ? "latest_by_case" : "succeeded"}
       ORDER BY recorded_at::TIMESTAMPTZ DESC, subject_id DESC
       ${maxRows == null ? "" : "LIMIT ?"}`,
      [
        AS_OF,
        AS_OF,
        AS_OF,
        CLINICAL_ANALYSIS_SCHEMA,
        options.caseId ?? null,
        options.caseId ?? null,
        ...(maxRows == null ? [] : [maxRows]),
      ],
    );
    return Promise.all(rows.map(async (row) => {
      const analysisId = row.subject_id.slice("analysis:".length);
      if (!analysisId) throw new Error("clinical analysis observation has an empty analysis id");
      if (row.value_json == null) throw new Error(`clinical analysis '${analysisId}' has no ledger value`);
      const value = JSON.parse(row.value_json) as Record<string, unknown>;
      const caseId = typeof value.case_id === "string" ? value.case_id : "";
      const packetDigest = typeof value.packet_digest === "string" ? value.packet_digest : "";
      const packetUri = typeof value.packet_uri === "string" ? value.packet_uri : "";
      if (!caseId || !packetDigest || !packetUri) {
        throw new Error(`clinical analysis '${analysisId}' has an incomplete ledger projection`);
      }
      const packet = await readEvidencePacket(exampleDir, packetDigest);
      if (packet.analysisId !== analysisId || packet.caseId !== caseId) {
        throw new Error(`clinical analysis '${analysisId}' does not match its CAS packet`);
      }
      return {
        packet,
        summary: {
          analysisId,
          caseId,
          packetDigest,
          packetUri,
          generatedAt: packet.generatedAt,
          recordedAt: new Date(row.recorded_at).toISOString(),
          reviewItems: packet.summary.reviewQueue.length,
          directCandidates: packet.summary.directCandidates,
          directAbstentions: packet.summary.directAbstentions,
          conflicts: packet.summary.conflicts,
          reanalysisSignals: packet.summary.reanalysisSignals,
        },
      };
    }));
  } finally {
    store.close();
  }
}

export async function listClinicalAnalyses(
  exampleDir: string,
  options: ClinicalAnalysisListOptions = {},
): Promise<ClinicalAnalysisSummary[]> {
  const records = await listClinicalAnalysisRecords(exampleDir, options, false);
  return records.map((record) => record.summary);
}

type CurrentReviewObservation = { valueJson: string | null; recordedAt: string | null };

async function currentReviewObservations(
  conn: SqlConn,
  statementKeys: readonly string[],
): Promise<Map<string, CurrentReviewObservation>> {
  const keys = [...new Set(statementKeys)];
  if (!keys.length) return new Map();
  const rows = await conn.all<{ statement_key: string; value_json: string | null; recorded_at: string }>(
    `WITH requested AS (
       SELECT json_extract_string(value, '$') AS statement_key
       FROM json_each(CAST(? AS JSON))
     ), eligible AS (
       SELECT observation.*
       FROM bio_observations observation
       JOIN requested USING (statement_key)
       WHERE observation.recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
         AND (observation.valid_from IS NULL OR observation.valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
         AND (observation.valid_to IS NULL OR observation.valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
     ), current AS (
       SELECT * EXCLUDE (rn) FROM (
         SELECT *, row_number() OVER (
           PARTITION BY statement_key
           ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC
         ) AS rn
         FROM eligible
       ) WHERE rn = 1
     )
     SELECT statement_key, value_json, recorded_at
     FROM current`,
    [JSON.stringify(keys), AS_OF, AS_OF, AS_OF],
  );
  return new Map(rows.map((row) => [row.statement_key, { valueJson: row.value_json, recordedAt: row.recorded_at }]));
}

function materializeClinicalReviewQueue(
  analysis: Extract<ClinicalAnalysisStatus, { found: true }>,
  observations: ReadonlyMap<string, CurrentReviewObservation>,
): ClinicalReviewQueueItem[] {
  return analysis.packet.summary.reviewQueue.map((item) => {
    const id = reviewId(item);
    const observation = observations.get(reviewStatementKey(analysis.analysisId, id));
    return currentReviewItem({
      item,
      analysisId: analysis.analysisId,
      caseId: analysis.packet.caseId,
      valueJson: observation?.valueJson ?? null,
      recordedAt: observation?.recordedAt ?? null,
    });
  });
}

export async function getClinicalReviewQueue(exampleDir: string, analysisId: string): Promise<ClinicalReviewQueueStatus> {
  const analysis = await getClinicalAnalysis(exampleDir, analysisId);
  if (!analysis.found) return analysis;
  const store = await openBioStore(exampleDir);
  try {
    const observations = await currentReviewObservations(
      store.conn,
      analysis.packet.summary.reviewQueue.map((item) => reviewStatementKey(analysisId, reviewId(item))),
    );
    const reviews = materializeClinicalReviewQueue(analysis, observations);
    return {
      found: true,
      analysisId,
      caseId: analysis.packet.caseId,
      packetDigest: analysis.packetDigest,
      reviews,
    };
  } finally {
    store.close();
  }
}

export async function updateClinicalReviewDisposition(
  exampleDir: string,
  analysisId: string,
  request: UpdateClinicalReviewDispositionRequest,
): Promise<ClinicalReviewQueueStatus> {
  const analysis = await getClinicalAnalysis(exampleDir, analysisId);
  if (!analysis.found) return analysis;
  const item = analysis.packet.summary.reviewQueue.find((candidate) => reviewId(candidate) === request.reviewId);
  if (!item) throw new ClinicalReviewInputError(`review '${request.reviewId}' does not belong to analysis '${analysisId}'`);
  const now = request.now ?? new Date().toISOString();
  const store = await openBioStore(exampleDir);
  try {
    const node = reviewNode(analysisId, request.reviewId);
    await inTransaction(store.conn, async () => {
      const observationId = await recordMonotonicObservation(store.conn, {
        statementKey: reviewStatementKey(analysisId, request.reviewId),
        subjectId: node,
        predicate: "review_disposition",
        value: {
          schema: CLINICAL_REVIEW_SCHEMA,
          analysis_id: analysisId,
          case_id: analysis.packet.caseId,
          review_id: request.reviewId,
          kind: item.kind,
          target: item.target,
          status: request.status,
          ...(request.note ? { note: request.note } : {}),
        },
        source: SOURCE,
        digest: analysis.packetDigest,
        attrs: {
          analysis_id: analysisId,
          case_id: analysis.packet.caseId,
          review_id: request.reviewId,
          review_kind: item.kind,
          review_target: item.target,
        },
      }, now, AS_OF);
      const rows = await store.conn.all<{ recorded_at: string }>(
        "SELECT recorded_at FROM bio_observations WHERE observation_id = ? LIMIT 1",
        [observationId],
      );
      const recordedAt = rows[0]?.recorded_at;
      if (!recordedAt) throw new Error(`clinical review '${request.reviewId}' was not recorded`);
      await recordObservationLink(store.conn, {
        statementKey: `analysis:${analysisId}:has_review:${request.reviewId}`,
        subjectId: `analysis:${analysisId}`,
        predicate: "has_review",
        objectId: node,
        recordedAt,
        source: SOURCE,
        digest: analysis.packetDigest,
      });
    });
  } finally {
    store.close();
  }
  return getClinicalReviewQueue(exampleDir, analysisId);
}

function nullableString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function reanalysisQueueEntry(
  summary: ClinicalAnalysisSummary,
  packet: EvidencePacket,
  reviews: ClinicalReviewQueueItem[],
): ClinicalReanalysisQueueEntry {
  const changes = packet.stages.reanalysis.rows.map((row) => ({
    variantKey: asString(row.variant_key),
    priorStatus: nullableString(row.prior_status),
    currentStatus: nullableString(row.current_status),
    changeStatus: asString(row.change_status),
  }));
  const needsFollowUpItems = reviews.filter((item) => item.status === "needs_follow_up").length;
  const openReviewItems = reviews.filter((item) => item.status !== "acknowledged").length;
  const evidenceGaps = packet.summary.directAbstentions + packet.summary.invertedGaps + packet.summary.invertedUnsearched;
  const reasons: string[] = [];
  if (needsFollowUpItems) reasons.push(`${needsFollowUpItems} review item${needsFollowUpItems === 1 ? " is" : "s are"} marked for follow-up.`);
  if (packet.summary.reanalysisSignals) reasons.push(`${packet.summary.reanalysisSignals} new or upgraded current assessment signal${packet.summary.reanalysisSignals === 1 ? "" : "s"}.`);
  if (packet.summary.conflicts) reasons.push(`${packet.summary.conflicts} evidence conflict${packet.summary.conflicts === 1 ? "" : "s"} remain explicit.`);
  if (evidenceGaps) reasons.push(`${evidenceGaps} recorded evidence gap${evidenceGaps === 1 ? "" : "s"} remain unresolved.`);
  if (!reasons.length && openReviewItems) reasons.push(`${openReviewItems} review item${openReviewItems === 1 ? " is" : "s are"} still open.`);
  if (!reasons.length) reasons.push("No active reanalysis signal is recorded for the latest analysis.");
  const state: ClinicalReanalysisQueueState = needsFollowUpItems > 0
    ? "needs_follow_up"
    : packet.summary.reanalysisSignals > 0
      ? "reanalysis_signal"
      : packet.summary.conflicts > 0
        ? "evidence_conflict"
        : evidenceGaps > 0
          ? "evidence_gap"
          : openReviewItems > 0
            ? "review_pending"
            : "no_active_signal";
  return {
    ...summary,
    groundingId: packet.grounding.groundingId,
    runIds: packet.provenance.runIds,
    state,
    reasons,
    changes,
    openReviewItems,
    needsFollowUpItems,
    evidenceGaps,
  };
}

const reanalysisQueueOrder: Record<ClinicalReanalysisQueueState, number> = {
  needs_follow_up: 0,
  reanalysis_signal: 1,
  evidence_conflict: 2,
  evidence_gap: 3,
  review_pending: 4,
  no_active_signal: 5,
};

export async function listClinicalReanalysisQueue(
  exampleDir: string,
  options: { limit?: number } = {},
): Promise<ClinicalReanalysisQueueEntry[]> {
  // Queue priority is derived from packet and review state, so select the latest packet for every case before
  // applying the caller's output limit. Capping raw history first would silently omit older cases with follow-up.
  const records = await listClinicalAnalysisRecords(exampleDir, {}, true, null);
  const store = await openBioStore(exampleDir);
  let entries: ClinicalReanalysisQueueEntry[];
  try {
    const reviewObservations = await currentReviewObservations(
      store.conn,
      records.flatMap(({ summary, packet }) => packet.summary.reviewQueue.map((item) => reviewStatementKey(summary.analysisId, reviewId(item)))),
    );
    entries = records.map(({ summary, packet }) => {
      const analysis: Extract<ClinicalAnalysisStatus, { found: true }> = {
        found: true,
        analysisId: summary.analysisId,
        packet,
        packetDigest: summary.packetDigest,
        packetUri: summary.packetUri,
      };
      return reanalysisQueueEntry(summary, packet, materializeClinicalReviewQueue(analysis, reviewObservations));
    });
  } finally {
    store.close();
  }
  entries.sort((left, right) =>
    reanalysisQueueOrder[left.state] - reanalysisQueueOrder[right.state]
    || right.recordedAt.localeCompare(left.recordedAt)
    || left.caseId.localeCompare(right.caseId),
  );
  return entries.slice(0, clinicalAnalysisLimit(options.limit));
}

export async function readEvidencePacket(exampleDir: string, packetDigest: string): Promise<EvidencePacket> {
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  const packet = await readCasJson(cas, packetDigest) as unknown as EvidencePacket;
  if (packet.schema !== EVIDENCE_PACKET_SCHEMA) throw new Error(`unsupported evidence packet schema '${String(packet.schema)}'`);
  return packet;
}
