import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalDigest,
  fsCasStore,
  openBioStore,
  readJobStepCheckpoint,
  recordObservation,
  recordObservationLink,
  runBioOperationFromManifest,
  runJobStepsWithCheckpoints,
  validateContentAddress,
  type BioManifest,
  type CasStore,
  type ContentAddress,
  type JsonValue,
  type RunCasRefs,
  type SqlConn,
} from "pi-bio-agent";

export const EVIDENCE_PACKET_SCHEMA = "pi-bio.workbench.evidence_packet.v1" as const;
export const CLINICAL_ANALYSIS_SCHEMA = "pi-bio.workbench.clinical_analysis.v1" as const;

const SOURCE = "pi-bio-workbench:clinical-genomics";
const WORKFLOW_VERSION = "clinical-evidence-workflow.v1";
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
  lanes: {
    direct: OperationRows;
    inverted: OperationRows;
    reanalysis: OperationRows;
  };
  summary: {
    directCandidates: number;
    directAbstentions: number;
    invertedSupportedHypotheses: number;
    invertedGaps: number;
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
    case "inverted_gap":
      return `${gene} is phenotype-supported, but no evidence-bearing variant in that gene passed the declared screen.`;
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

function buildPacket(args: {
  analysisId: string;
  caseId: string;
  generatedAt: string;
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
    lanes: { direct, inverted, reanalysis: args.reanalysis },
    summary: {
      directCandidates: direct.rows.filter((row) => row.variant_bucket === "candidate").length,
      directAbstentions: direct.rows.filter((row) => asString(row.variant_bucket).startsWith("abstain_")).length,
      invertedSupportedHypotheses: distinctCount(inverted.rows, "genotype_supports_hypothesis"),
      invertedGaps: distinctCount(inverted.rows, "hypothesis_without_supporting_variant"),
      conflicts: direct.rows.filter((row) => row.conflict != null).length,
      reanalysisSignals: args.reanalysis.rows.filter((row) =>
        (row.change_status === "new" || row.change_status === "upgraded")
        && (row.current_status === "candidate_needs_review" || row.current_status === "curated_plp_candidate")
      ).length,
      reviewQueue,
      kernelScope: "evidence routing only; not a complete clinical classification kernel",
    },
    provenance: { runIds: [args.evidence.runId, args.reanalysis.runId] },
  };
}

async function runOperation(args: {
  exampleDir: string;
  conn: SqlConn;
  cas: CasStore;
  caseId: string;
  operationId: string;
  runId: string;
  now: string;
  dbPath: string;
}): Promise<OperationCheckpoint> {
  const response = await runBioOperationFromManifest({
    cwd: args.exampleDir,
    dbPath: args.dbPath,
    manifestPath: "manifest.json",
    operationId: args.operationId,
    runId: args.runId,
    now: args.now,
    store: args.conn,
    author: SOURCE,
    cas: args.cas,
    casMetadata: { conn: args.conn },
    serialize: false,
    bindings: { case_id: args.caseId },
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

async function workflowReplayDigest(exampleDir: string, caseId: string): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(join(exampleDir, "manifest.json"), "utf8")) as BioManifest;
  const inputs: Array<{ resourceId: string; digest: string }> = [];
  for (const resource of manifest.provides?.resources ?? []) {
    if (resource.resolver !== "duckdb.file_scan" || typeof resource.params.path !== "string") continue;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(resolve(exampleDir, resource.params.path))) hash.update(chunk);
    inputs.push({ resourceId: resource.id, digest: `sha256:${hash.digest("hex")}` });
  }
  inputs.sort((left, right) => left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0);
  return canonicalDigest({ schema: WORKFLOW_VERSION, caseId, manifest, inputs });
}

export async function runClinicalGenomicsWorkbench(req: RunClinicalGenomicsRequest): Promise<RunClinicalGenomicsResult> {
  const now = req.now ?? new Date().toISOString();
  const analysisId = req.analysisId ?? `clinical-${randomUUID()}`;
  const replayDigest = await workflowReplayDigest(req.exampleDir, req.caseId);
  const analysisDbDir = join(req.exampleDir, ".pi", "bio-agent", "analyses");
  const analysisDbPath = join(analysisDbDir, `${createHash("sha256").update(analysisId).digest("hex")}.duckdb`);
  await fs.mkdir(analysisDbDir, { recursive: true });
  const store = await openBioStore(req.exampleDir);
  const cas = fsCasStore(join(req.exampleDir, ".pi", "bio-agent", "cas"));
  try {
    const workflow = await runJobStepsWithCheckpoints(store.conn, {
      runId: analysisId,
      recordedAt: now,
      replayDigest,
      source: SOURCE,
      steps: [
        {
          stepId: "case-evidence",
          run: async () => toJsonValue(await runOperation({
            exampleDir: req.exampleDir,
            conn: store.conn,
            cas,
            caseId: req.caseId,
            operationId: "clinical.case_evidence",
            runId: `${analysisId}.evidence`,
            now,
            dbPath: analysisDbPath,
          })),
        },
        {
          stepId: "reanalysis",
          run: async () => toJsonValue(await runOperation({
            exampleDir: req.exampleDir,
            conn: store.conn,
            cas,
            caseId: req.caseId,
            operationId: "clinical.reanalysis_diff",
            runId: `${analysisId}.reanalysis`,
            now,
            dbPath: analysisDbPath,
          })),
        },
        {
          stepId: PACKET_STEP,
          run: async ({ valueOf }) => {
            const evidenceCheckpoint = valueOf<JsonValue>("case-evidence") as unknown as OperationCheckpoint;
            const reanalysisCheckpoint = valueOf<JsonValue>("reanalysis") as unknown as OperationCheckpoint;
            const evidence = await readOperationRows(cas, evidenceCheckpoint);
            const reanalysis = await readOperationRows(cas, reanalysisCheckpoint);
            const packet = buildPacket({ analysisId, caseId: req.caseId, generatedAt: now, evidence, reanalysis });
            return toJsonValue(await recordPacket({ conn: store.conn, cas, packet, recordedAt: now }));
          },
        },
      ],
    });
    const checkpoint = workflow.steps.find((step) => step.stepId === PACKET_STEP)?.value as PacketCheckpoint | undefined;
    if (!checkpoint) throw new Error(`analysis '${analysisId}' completed without an evidence packet checkpoint`);
    const packet = await readEvidencePacket(req.exampleDir, checkpoint.packetDigest);
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
      storePath: join(req.exampleDir, ".pi", "bio-agent", "store.duckdb"),
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
