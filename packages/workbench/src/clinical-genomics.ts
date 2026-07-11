import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalDigest,
  fsCasStore,
  openBioStore,
  readJobStepCheckpoint,
  recordArtifactReference,
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

export const EVIDENCE_PACKET_SCHEMA = "pi-bio.workbench.evidence_packet.v1" as const;
export const CLINICAL_ANALYSIS_SCHEMA = "pi-bio.workbench.clinical_analysis.v1" as const;

const SOURCE = "pi-bio-workbench:clinical-genomics";
const WORKFLOW_VERSION = "clinical-evidence-workflow.v5";
const PACKET_MEDIA_TYPE = "application/vnd.pi-bio.workbench.evidence+json";
const PACKET_STEP = "packet";

type JsonRecord = { [key: string]: JsonValue };

export interface RunClinicalGenomicsRequest {
  /** Host-owned directory containing manifest.json and data/. */
  exampleDir: string;
  caseId: string;
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
  return {
    url: process.env.PI_BIO_VEP_URL ?? "https://rest.ensembl.org/vep/human/region",
    headersJson: process.env.PI_BIO_VEP_HEADERS_JSON ?? "[{\"name\":\"Content-Type\",\"value\":\"application/json\"},{\"name\":\"Accept\",\"value\":\"application/json\"}]",
    ...(process.env.PI_BIO_VEP_PROFILE_ID ? { profileId: process.env.PI_BIO_VEP_PROFILE_ID } : {}),
    sourceId: process.env.PI_BIO_VEP_SOURCE_ID ?? "https://rest.ensembl.org/vep/human/region",
    sourceVersion: process.env.PI_BIO_VEP_SOURCE_VERSION ?? "live",
    duckdbInitSql: [
      "LOAD ducknng",
      "SET VARIABLE vep_tls_config_id = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)",
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
  stages: {
    hypotheses: OperationRows;
    intervals: OperationRows;
    variantSearch: OperationRows;
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
  grounding: GroundingCheckpoint;
  hypotheses: OperationRows;
  intervals: OperationRows;
  variantSearch: OperationRows;
  vep: OperationRows;
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
    stages: {
      hypotheses: args.hypotheses,
      intervals: args.intervals,
      variantSearch: args.variantSearch,
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
      conflicts: direct.rows.filter((row) => row.conflict != null).length,
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
    manifestPath: "manifest.json",
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
  analysisDbPath: string;
  ledger: SqlConn;
  cas: CasStore;
  caseId: string;
  analysisId: string;
  now: string;
  composition: GroundingRuntime;
}): Promise<GroundingCheckpoint> {
  const narrativeQuery = await runGroundingQuery({
    ...args,
    runId: `${args.analysisId}.grounding.narrative`,
    sql: "SELECT narrative FROM case_narratives WHERE case_id = getvariable('case_id')",
    resources: ["case_narratives"],
    bindings: { case_id: args.caseId },
  });
  if (narrativeQuery.rows.length !== 1) throw new Error(`expected one immutable narrative for case '${args.caseId}'`);
  const narrative = asString(narrativeQuery.rows[0]?.narrative);
  if (!narrative) throw new Error(`case '${args.caseId}' has an empty narrative`);
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
): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
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
  const composition = req.grounding;
  const replayDigest = await workflowReplayDigest(exampleDir, req.caseId, composition, req.hypotheses, req.variantSearch, req.vep);
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
            analysisDbPath,
            ledger: store.conn,
            cas,
            caseId: req.caseId,
            analysisId,
            now,
            composition,
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
              manifestPath: req.variantSearch.intervalManifestPath,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: req.variantSearch.intervalOperationId,
              runId: `${analysisId}.intervals`,
              now,
              dbPath: analysisDbPath,
              bindings: { assembly: req.variantSearch.assembly },
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
            const templatePath = isAbsolute(req.variantSearch.variantSearchManifestPath)
              ? req.variantSearch.variantSearchManifestPath
              : resolve(req.variantSearch.manifestBaseDir, req.variantSearch.variantSearchManifestPath);
            const template = JSON.parse(await fs.readFile(templatePath, "utf8")) as BioManifest;
            const dynamic = buildCandidateVariantSearchManifest(
              template,
              intervals.rows as unknown as CandidateIntervalRow[],
              req.variantSearch,
            );
            const search = await runOperation({
              exampleDir,
              manifestSnapshot: dynamic.manifest,
              manifestBaseDir: req.variantSearch.manifestBaseDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: req.variantSearch.variantSearchOperationId,
              runId: `${analysisId}.variant-search`,
              now,
              dbPath: analysisDbPath,
              ...(dynamic.regions.length ? { duckdbInitSql: req.variantSearch.duckdbInitSql } : {}),
              protectedBindings: {
                intervals_json: JSON.stringify(intervals.rows),
                case_vcf_path: req.variantSearch.vcfPath.includes("://") || isAbsolute(req.variantSearch.vcfPath)
                  ? req.variantSearch.vcfPath
                  : resolve(req.variantSearch.manifestBaseDir, req.variantSearch.vcfPath),
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
            const selected = variantSearch.rows.filter((row) => row.record_kind === "variant");
            const manifest = JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
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
          stepId: "reanalysis",
          run: async ({ valueOf }) => {
            const annotationCheckpoint = valueOf<JsonValue>("vep-annotation") as unknown as OperationCheckpoint;
            const annotations = await readOperationRows(cas, annotationCheckpoint);
            return toJsonValue(await runOperation({
              exampleDir,
              conn: store.conn,
              cas,
              caseId: req.caseId,
              operationId: "clinical.reanalysis_diff",
              runId: `${analysisId}.reanalysis`,
              now,
              dbPath: analysisDbPath,
              protectedBindings: {
                candidate_variant_search_json: "[]",
                vep_annotations_json: JSON.stringify(annotations.rows),
              },
            }));
          },
        },
        {
          stepId: "case-evidence",
          run: async ({ valueOf }) => {
            const hypothesisCheckpoint = valueOf<JsonValue>("phenotype-hypotheses") as unknown as OperationCheckpoint;
            const variantSearchCheckpoint = valueOf<JsonValue>("candidate-variant-search") as unknown as OperationCheckpoint;
            const annotationCheckpoint = valueOf<JsonValue>("vep-annotation") as unknown as OperationCheckpoint;
            const hypotheses = await readOperationRows(cas, hypothesisCheckpoint);
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const annotations = await readOperationRows(cas, annotationCheckpoint);
            const evidence = await runOperation({
              exampleDir,
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
                vep_annotations_json: JSON.stringify(annotations.rows),
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
            const evidenceCheckpoint = valueOf<JsonValue>("case-evidence") as unknown as OperationCheckpoint;
            const reanalysisCheckpoint = valueOf<JsonValue>("reanalysis") as unknown as OperationCheckpoint;
            const hypotheses = await readOperationRows(cas, hypothesisCheckpoint);
            const intervals = await readOperationRows(cas, intervalCheckpoint);
            const variantSearch = await readOperationRows(cas, variantSearchCheckpoint);
            const vep = await readOperationRows(cas, annotationCheckpoint);
            const evidence = await readOperationRows(cas, evidenceCheckpoint);
            const reanalysis = await readOperationRows(cas, reanalysisCheckpoint);
            const packet = buildPacket({
              analysisId,
              caseId: req.caseId,
              generatedAt: now,
              grounding: groundingCheckpoint,
              hypotheses,
              intervals,
              variantSearch,
              vep,
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

export async function readEvidencePacket(exampleDir: string, packetDigest: string): Promise<EvidencePacket> {
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  const packet = await readCasJson(cas, packetDigest) as unknown as EvidencePacket;
  if (packet.schema !== EVIDENCE_PACKET_SCHEMA) throw new Error(`unsupported evidence packet schema '${String(packet.schema)}'`);
  return packet;
}
