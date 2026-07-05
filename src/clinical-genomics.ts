import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  fsCasStore,
  openBioStore,
  recordObservation,
  recordObservationLink,
  runBioOperationFromManifest,
  type BioStore,
  type RunOperationResponse,
  type SqlConn,
} from "pi-bio-agent";

export const EVIDENCE_PACKET_SCHEMA = "pi-bio.workbench.evidence_packet.v1";

const SOURCE = "pi-bio-workbench:clinical-genomics";
type WorkbenchCasStore = ReturnType<typeof fsCasStore>;

export interface RunClinicalGenomicsRequest {
  /** Directory containing manifest.json and data/. Defaults to examples/clinical-genomics from the caller. */
  exampleDir: string;
  caseId: string;
  now?: string;
}

export interface OperationRows {
  operationId: string;
  runId: string;
  rows: Array<Record<string, unknown>>;
  casRefs?: RunOperationResponse["casRefs"];
}

export interface EvidencePacket {
  schema: typeof EVIDENCE_PACKET_SCHEMA;
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
    reanalysisSignals: number;
    reviewQueue: Array<{ kind: string; target: string; reason: string }>;
    kernelScope: string;
  };
  provenance: {
    runIds: string[];
    packetDigest: string;
    packetUri: string;
  };
}

export interface RunClinicalGenomicsResult {
  packet: EvidencePacket;
  packetDigest: string;
  packetUri: string;
  runs: OperationRows[];
  storePath: string;
}

function safeId(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? Number(v) : v));
}

async function readRows(runDir: string): Promise<Array<Record<string, unknown>>> {
  const result = JSON.parse(await fs.readFile(join(runDir, "result.json"), "utf8")) as { rows: Array<Record<string, unknown>> };
  return result.rows;
}

async function runOperation(
  exampleDir: string,
  store: BioStore,
  cas: WorkbenchCasStore,
  caseId: string,
  operationId: string,
  runId: string,
  now: string,
): Promise<OperationRows> {
  const res = await runBioOperationFromManifest({
    cwd: exampleDir,
    dbPath: ":memory:",
    manifestPath: "manifest.json",
    operationId,
    runId,
    now,
    store: store.conn,
    author: SOURCE,
    cas,
    bindings: { case_id: caseId },
  });
  if (!res.ok) throw new Error(`${operationId} failed: ${res.error}`);
  return { operationId, runId: res.runId, rows: await readRows(res.runDir), casRefs: res.casRefs };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function buildReviewQueue(args: {
  direct: Array<Record<string, unknown>>;
  inverted: Array<Record<string, unknown>>;
  reanalysis: Array<Record<string, unknown>>;
}): EvidencePacket["summary"]["reviewQueue"] {
  const queue: EvidencePacket["summary"]["reviewQueue"] = [];
  for (const r of args.direct) {
    const variant = asString(r.variant_key);
    if (r.bucket === "candidate") {
      queue.push({
        kind: r.evidence_status === "curated_plp_candidate" ? "confirm_candidate" : "adjudicate_candidate",
        target: `variant:${variant}`,
        reason: `${variant} is rare high-impact by the direct lane; clinical kernel edge cases are still review-bound.`,
      });
    }
    if (r.bucket === "abstain_no_frequency") {
      queue.push({
        kind: "resolve_frequency",
        target: `variant:${variant}`,
        reason: `${variant} has no usable allele frequency and was not counted as rare.`,
      });
    }
  }
  for (const r of args.inverted) {
    const gene = asString(r.gene);
    if (r.hypothesis_bucket === "hypothesis_without_variant") {
      queue.push({
        kind: "inverted_gap",
        target: `gene:${gene}`,
        reason: `${gene} is phenotype-supported, but this case fixture has no supporting variant in that gene.`,
      });
    }
  }
  for (const r of args.reanalysis) {
    if ((r.status === "new" || r.status === "upgraded") && r.current_status === "curated_plp_candidate") {
      queue.push({
        kind: "reanalysis_signal",
        target: `variant:${asString(r.variant_key)}`,
        reason: `${asString(r.variant_key)} is ${asString(r.status)} versus the prior assessment.`,
      });
    }
  }
  return queue;
}

function buildPacket(caseId: string, generatedAt: string, direct: OperationRows, inverted: OperationRows, reanalysis: OperationRows): Omit<EvidencePacket, "provenance"> {
  const reviewQueue = buildReviewQueue({ direct: direct.rows, inverted: inverted.rows, reanalysis: reanalysis.rows });
  return {
    schema: EVIDENCE_PACKET_SCHEMA,
    caseId,
    generatedAt,
    lanes: { direct, inverted, reanalysis },
    summary: {
      directCandidates: direct.rows.filter((r) => r.bucket === "candidate").length,
      directAbstentions: direct.rows.filter((r) => String(r.bucket).startsWith("abstain_")).length,
      invertedSupportedHypotheses: inverted.rows.filter((r) => r.hypothesis_bucket === "genotype_supports_hypothesis").length,
      invertedGaps: inverted.rows.filter((r) => r.hypothesis_bucket === "hypothesis_without_variant").length,
      reanalysisSignals: reanalysis.rows.filter((r) => (r.status === "new" || r.status === "upgraded") && r.current_status === "curated_plp_candidate").length,
      reviewQueue,
      kernelScope: "evidence-routing only; not a complete ACMG/AMP classifier",
    },
  };
}

async function recordPacket(conn: SqlConn, cas: WorkbenchCasStore, packetWithoutProvenance: Omit<EvidencePacket, "provenance">, runIds: string[], recordedAt: string): Promise<EvidencePacket> {
  const storedPacket = { ...packetWithoutProvenance, provenance: { runIds } };
  const storedBytes = Buffer.from(canonicalJson(storedPacket), "utf8");
  const digest = sha256(storedBytes);
  const packetDigest = `sha256:${digest}`;
  const packetUri = `cas:${packetDigest}`;
  const packet: EvidencePacket = {
    ...packetWithoutProvenance,
    provenance: { runIds, packetDigest, packetUri },
  };
  await cas.put({ algorithm: "sha256", digest, sizeBytes: storedBytes.length, mediaType: "application/vnd.pi-bio.workbench.evidence+json" }, storedBytes);

  const caseNode = `case:${packet.caseId}`;
  await recordObservation(conn, {
    statementKey: `${caseNode}:evidence_packet`,
    subjectId: caseNode,
    predicate: "evidence_packet",
    value: {
      schema: packet.schema,
      case_id: packet.caseId,
      packet_digest: packetDigest,
      packet_uri: packetUri,
      direct_candidates: packet.summary.directCandidates,
      direct_abstentions: packet.summary.directAbstentions,
      inverted_supported_hypotheses: packet.summary.invertedSupportedHypotheses,
      inverted_gaps: packet.summary.invertedGaps,
      reanalysis_signals: packet.summary.reanalysisSignals,
      review_items: packet.summary.reviewQueue.length,
    },
    recordedAt,
    source: SOURCE,
    digest: packetDigest,
    attrs: { media_type: "application/vnd.pi-bio.workbench.evidence+json" },
  });
  await recordObservation(conn, {
    statementKey: packetUri,
    subjectId: packetUri,
    predicate: "artifact",
    value: {
      digest: packetDigest,
      uri: packetUri,
      media_type: "application/vnd.pi-bio.workbench.evidence+json",
      semantic_role: "evidence_packet",
      size_bytes: storedBytes.length,
    },
    recordedAt,
    source: SOURCE,
    digest: packetDigest,
    attrs: { case_id: packet.caseId },
  });
  await recordObservationLink(conn, {
    subjectId: caseNode,
    predicate: "produces",
    objectId: packetUri,
    recordedAt,
    source: SOURCE,
    digest: packetDigest,
    attrs: { semantic_role: "evidence_packet" },
  });
  for (const runId of runIds) {
    await recordObservationLink(conn, {
      subjectId: caseNode,
      predicate: "uses_run",
      objectId: `run:${runId}`,
      recordedAt,
      source: SOURCE,
      digest: packetDigest,
    });
    await recordObservationLink(conn, {
      subjectId: packetUri,
      predicate: "derived_from",
      objectId: `run:${runId}`,
      recordedAt,
      source: SOURCE,
      digest: packetDigest,
    });
  }
  return packet;
}

export async function runClinicalGenomicsWorkbench(req: RunClinicalGenomicsRequest): Promise<RunClinicalGenomicsResult> {
  const now = req.now ?? new Date().toISOString();
  const caseId = req.caseId;
  const exampleDir = req.exampleDir;
  const store = await openBioStore(exampleDir);
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  try {
    const prefix = safeId(caseId);
    const direct = await runOperation(exampleDir, store, cas, caseId, "clinical.direct_variant_triage", `clinical-direct-${prefix}`, now);
    const inverted = await runOperation(exampleDir, store, cas, caseId, "clinical.inverted_phenotype_hypotheses", `clinical-inverted-${prefix}`, now);
    const reanalysis = await runOperation(exampleDir, store, cas, caseId, "clinical.reanalysis_diff", `clinical-reanalysis-${prefix}`, now);
    const packetWithoutProvenance = buildPacket(caseId, now, direct, inverted, reanalysis);
    const packet = await recordPacket(store.conn, cas, packetWithoutProvenance, [direct.runId, inverted.runId, reanalysis.runId], now);
    return {
      packet,
      packetDigest: packet.provenance.packetDigest,
      packetUri: packet.provenance.packetUri,
      runs: [direct, inverted, reanalysis],
      storePath: join(exampleDir, ".pi", "bio-agent", "store.duckdb"),
    };
  } finally {
    store.close();
  }
}
