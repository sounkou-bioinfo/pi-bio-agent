import { createHash, createHmac, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  canonicalDigest,
  fsCasStore,
  inTransaction,
  observationAsOfKey,
  openBioStore,
  recordArtifactReference,
  recordObservation,
  recordObservationLink,
  runBioOperationFromManifest,
  type BioManifest,
  type CasStore,
  type HostCapabilityReceipt,
  type JsonValue,
  type RunCasRefs,
  type SqlConn,
} from "pi-bio-agent";
import { duckdbNodeConn } from "pi-bio-agent/duckdb";

/** A release-pinned, normalized ClinVar record set. Raw TSV/XML stays in CAS; DuckLake holds the large relation. */
export const CLINVAR_NORMALIZED_RELEASE_SCHEMA = "pi-bio.workbench.clinvar_normalized_release.v1" as const;
export const CLINVAR_RELEASE_SCHEMA = "pi-bio.workbench.clinvar_release.v1" as const;
export const CLINVAR_TEMPORAL_TASK_SCHEMA = "pi-bio.workbench.clinvar_temporal_task.v1" as const;
export const CLINVAR_TEMPORAL_EVALUATION_SCHEMA = "pi-bio.workbench.clinvar_temporal_evaluation.v1" as const;
export const CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA = "pi-bio.workbench.clinvar_temporal_isolation_receipt.v1" as const;

const SOURCE = "pi-bio-workbench:clinvar-temporal";
const RAW_MEDIA_TYPE = "application/vnd.pi-bio.workbench.clinvar-source";
const NORMALIZED_MEDIA_TYPE = "application/vnd.pi-bio.workbench.clinvar-normalized+json";
const TEMPORAL_TASK_MEDIA_TYPE = "application/vnd.pi-bio.workbench.clinvar-temporal-task+json";
const TEMPORAL_COMMITMENT_SECRET_MEDIA_TYPE = "application/vnd.pi-bio.workbench.clinvar-temporal-commitment-secret";
const AS_OF = "9999-12-31T23:59:59.999Z";
const CATALOG_ALIAS = "clinvar_lake";
const LAKE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BOUNDARY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type ClinVarSourceFormat = "tsv" | "vcv_xml" | "rcv_xml" | "vcf" | "other";
export type ClinVarRecordScope = "variation_aggregate" | "condition_aggregate" | "submission";

const SOURCE_FORMATS = new Set<ClinVarSourceFormat>(["tsv", "vcv_xml", "rcv_xml", "vcf", "other"]);

/** Host-owned local DuckLake paths. A shared catalog backend can be introduced through host composition later. */
export interface ClinVarDuckLakeConfig {
  lakeId: string;
  catalogPath: string;
  dataPath: string;
}

export interface ClinVarRawSourceInput {
  uri: string;
  format: ClinVarSourceFormat;
  mediaType?: string;
  bytes: Buffer | Uint8Array;
}

/** The parser is a declared upstream producer identity, not a hidden XML/TSV interpretation inside this registry. */
export interface ClinVarParserIdentity {
  id: string;
  version: string;
  implementationDigest: `sha256:${string}`;
}

/**
 * One source-level clinical assertion/aggregate row. `temporalKey` is supplied by the normalizer because VCV,
 * RCV, and SCV identity are not interchangeable; the temporal harness never guesses an identity join.
 */
export interface ClinVarAssertionInput {
  assertionId: string;
  temporalKey: string;
  recordScope: ClinVarRecordScope;
  variationId: string;
  conditionId?: string;
  conditionLabel?: string;
  geneIds?: readonly string[];
  clinicalSignificance: string;
  reviewStatus?: string;
  submitter?: string;
  lastEvaluated?: string;
  attributes?: Record<string, JsonValue>;
}

export interface RegisterClinVarReleaseRequest {
  lake: ClinVarDuckLakeConfig;
  releaseId: string;
  releasedAt: string;
  rawSource: ClinVarRawSourceInput;
  parser: ClinVarParserIdentity;
  assertions: readonly ClinVarAssertionInput[];
  /** Event time for registry provenance. It does not change the release identity. */
  recordedAt?: string;
}

export interface ClinVarRelease {
  schema: typeof CLINVAR_RELEASE_SCHEMA;
  lakeId: string;
  releaseId: string;
  releasedAt: string;
  sourceUri: string;
  sourceFormat: ClinVarSourceFormat;
  rawDigest: `sha256:${string}`;
  rawUri: `cas:sha256:${string}`;
  rawMediaType: string;
  normalizedDigest: `sha256:${string}`;
  normalizedUri: `cas:sha256:${string}`;
  parser: ClinVarParserIdentity;
  assertionCount: number;
  /** The exact DuckLake snapshot containing this import, not the mutable latest catalog state. */
  duckLakeSnapshotId: number;
  /** Opaque host-configuration binding for the catalog/data paths used to attach this release. */
  duckLakeConfigDigest: `sha256:${string}`;
  releaseDigest: `sha256:${string}`;
  recordedAt: string;
}

export interface ClinVarReleaseSummary extends Pick<ClinVarRelease,
  "lakeId" | "releaseId" | "releasedAt" | "sourceUri" | "sourceFormat" | "rawDigest" | "normalizedDigest"
  | "assertionCount" | "duckLakeSnapshotId" | "duckLakeConfigDigest" | "releaseDigest" | "recordedAt"> {}

/** The only source-label states eligible for an agent's baseline-only task. Selection is mechanical and inspectable. */
export interface ClinVarTemporalCandidatePolicy {
  baselineClinicalSignificances: readonly string[];
  baselineReviewStatuses?: readonly string[];
}

/**
 * A host-issued attestation that an agent and evaluator run in separate access boundaries. The workbench validates
 * and pins this secret-free receipt, but the host is responsible for the process, filesystem, and tool isolation.
 */
export interface ClinVarTemporalIsolationReceipt extends HostCapabilityReceipt {
  schema: typeof CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA;
  policyDigest: `sha256:${string}`;
  mode: "host_enforced";
  agentBoundaryId: string;
  evaluatorBoundaryId: string;
  targetAccess: "evaluator_only";
}

export interface ClinVarTemporalTaskBaseline {
  lakeId: string;
  releaseId: string;
  releasedAt: string;
  releaseDigest: `sha256:${string}`;
  normalizedDigest: `sha256:${string}`;
  duckLakeSnapshotId: number;
  duckLakeConfigDigest: `sha256:${string}`;
}

/**
 * Safe-to-hand-to-agent task record. It has exactly one locally materialized baseline release and an opaque target
 * commitment; it intentionally has no target release id, source URI, timestamp, classification, or assertion row.
 */
export interface ClinVarTemporalTask {
  schema: typeof CLINVAR_TEMPORAL_TASK_SCHEMA;
  taskId: string;
  agentBaseline: ClinVarTemporalTaskBaseline;
  candidatePolicy: {
    baselineClinicalSignificances: string[];
    baselineReviewStatuses?: string[];
  };
  targetCommitment: `sha256:${string}`;
  isolation: ClinVarTemporalIsolationReceipt;
  taskDigest: `sha256:${string}`;
}

/** Evaluator-only record. Do not inject this into an agent workspace or prompt. */
export interface ClinVarTemporalEvaluation {
  schema: typeof CLINVAR_TEMPORAL_EVALUATION_SCHEMA;
  taskId: string;
  taskDigest: `sha256:${string}`;
  evaluatorBaseline: ClinVarTemporalTaskBaseline;
  target: ClinVarTemporalTaskBaseline;
  targetCommitment: `sha256:${string}`;
  isolation: ClinVarTemporalIsolationReceipt;
  recordedAt: string;
}

export interface PrepareClinVarTemporalTaskRequest {
  /** Workspace whose ledger/CAS/DuckLake can hold the target release and evaluator run records. */
  evaluatorWorkspace: string;
  /** Separate host-enforced workspace exposed to the acting agent. */
  agentWorkspace: string;
  evaluatorLake: ClinVarDuckLakeConfig;
  /** Defaults to a local DuckLake catalog under agentWorkspace. It must not alias evaluatorLake. */
  agentLake?: ClinVarDuckLakeConfig;
  baseline: ClinVarRelease;
  target: ClinVarRelease;
  candidatePolicy: ClinVarTemporalCandidatePolicy;
  /** At least 32 bytes of evaluator-only entropy. It never enters the task artifact or agent workspace. */
  targetCommitmentSecret: Buffer | Uint8Array;
  isolationReceipt: ClinVarTemporalIsolationReceipt;
  taskId?: string;
  recordedAt?: string;
}

export interface PreparedClinVarTemporalTask {
  task: ClinVarTemporalTask;
  taskArtifactDigest: `sha256:${string}`;
  taskArtifactUri: `cas:sha256:${string}`;
  agentRelease: ClinVarRelease;
}

export interface RecordedClinVarOperation {
  runId: string;
  rows: Array<Record<string, unknown>>;
  casRefs: RunCasRefs;
}

export class ClinVarTemporalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClinVarTemporalInputError";
  }
}

type NormalizedClinVarAssertion = {
  assertionId: string;
  temporalKey: string;
  recordScope: ClinVarRecordScope;
  variationId: string;
  conditionId?: string;
  conditionLabel?: string;
  geneIds: string[];
  clinicalSignificance: string;
  reviewStatus?: string;
  submitter?: string;
  lastEvaluated?: string;
  attributes?: Record<string, JsonValue>;
};

type NormalizedRelease = {
  schema: typeof CLINVAR_NORMALIZED_RELEASE_SCHEMA;
  releaseId: string;
  releasedAt: string;
  parser: ClinVarParserIdentity;
  assertions: NormalizedClinVarAssertion[];
};

type ReleaseLedgerValue = {
  schema: typeof CLINVAR_RELEASE_SCHEMA;
  lake_id: string;
  release_id: string;
  released_at: string;
  source_uri: string;
  source_format: ClinVarSourceFormat;
  raw_digest: `sha256:${string}`;
  raw_uri: `cas:sha256:${string}`;
  raw_media_type: string;
  normalized_digest: `sha256:${string}`;
  normalized_uri: `cas:sha256:${string}`;
  parser_id: string;
  parser_version: string;
  parser_digest: `sha256:${string}`;
  assertion_count: number;
  ducklake_snapshot_id: number;
  ducklake_config_digest: `sha256:${string}`;
  release_digest: `sha256:${string}`;
};

type TemporalTaskLedgerValue = {
  schema: typeof CLINVAR_TEMPORAL_TASK_SCHEMA;
  task_id: string;
  task_digest: `sha256:${string}`;
  task_artifact_digest: `sha256:${string}`;
  task_artifact_uri: `cas:sha256:${string}`;
  agent_lake_id: string;
  agent_release_id: string;
  agent_release_digest: `sha256:${string}`;
  agent_lake_config_digest: `sha256:${string}`;
  target_commitment: `sha256:${string}`;
  isolation_policy_digest: `sha256:${string}`;
};

type TemporalEvaluationLedgerValue = {
  schema: typeof CLINVAR_TEMPORAL_EVALUATION_SCHEMA;
  task_id: string;
  task_digest: `sha256:${string}`;
  evaluator_baseline_lake_id: string;
  evaluator_baseline_release_id: string;
  evaluator_baseline_release_digest: `sha256:${string}`;
  evaluator_baseline_lake_config_digest: `sha256:${string}`;
  target_lake_id: string;
  target_release_id: string;
  target_release_digest: `sha256:${string}`;
  target_lake_config_digest: `sha256:${string}`;
  target_commitment: `sha256:${string}`;
  target_commitment_secret_digest: `sha256:${string}`;
  target_commitment_secret_uri: `cas:sha256:${string}`;
  isolation_schema: typeof CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA;
  isolation_mode: "host_enforced";
  agent_boundary_id: string;
  evaluator_boundary_id: string;
  target_access: "evaluator_only";
  isolation_policy_digest: `sha256:${string}`;
};

function assertText(label: string, value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new ClinVarTemporalInputError(`${label} must be non-empty`);
  return trimmed;
}

function assertLakeId(value: unknown): string {
  if (typeof value !== "string") throw new ClinVarTemporalInputError(`lakeId must match ${LAKE_ID_RE}`);
  if (!LAKE_ID_RE.test(value)) throw new ClinVarTemporalInputError(`lakeId must match ${LAKE_ID_RE}`);
  return value;
}

function assertReleaseId(value: unknown): string {
  if (typeof value !== "string") throw new ClinVarTemporalInputError(`releaseId must match ${RELEASE_ID_RE}`);
  if (!RELEASE_ID_RE.test(value)) throw new ClinVarTemporalInputError(`releaseId must match ${RELEASE_ID_RE}`);
  return value;
}

function assertTaskId(value: unknown): string {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    throw new ClinVarTemporalInputError(`taskId must match ${TASK_ID_RE}`);
  }
  return value;
}

function assertBoundaryId(label: string, value: unknown): string {
  if (typeof value !== "string" || !BOUNDARY_ID_RE.test(value)) {
    throw new ClinVarTemporalInputError(`${label} must match ${BOUNDARY_ID_RE}`);
  }
  return value;
}

function assertDigest(label: string, value: unknown): `sha256:${string}` {
  if (typeof value !== "string") throw new ClinVarTemporalInputError(`${label} must be sha256:<64 lowercase hex characters>`);
  if (!SHA256_RE.test(value)) throw new ClinVarTemporalInputError(`${label} must be sha256:<64 lowercase hex characters>`);
  return value as `sha256:${string}`;
}

function assertCasUri(label: string, value: unknown): `cas:sha256:${string}` {
  const uri = assertText(label, value);
  if (!uri.startsWith("cas:sha256:") || !SHA256_RE.test(uri.slice("cas:".length))) {
    throw new ClinVarTemporalInputError(`${label} must be cas:sha256:<64 lowercase hex characters>`);
  }
  return uri as `cas:sha256:${string}`;
}

function assertMediaType(label: string, value: unknown, fallback: string): string {
  const mediaType = typeof value === "string" ? value.trim() || fallback : fallback;
  if (!mediaType.includes("/")) throw new ClinVarTemporalInputError(`${label} must be a MIME type`);
  return mediaType;
}

function assertTimestamp(label: string, value: unknown): string {
  const timestamp = assertText(label, value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new ClinVarTemporalInputError(`${label} must be a valid timestamp`);
  return timestamp;
}

function assertSourceFormat(value: unknown): ClinVarSourceFormat {
  if (typeof value !== "string" || !SOURCE_FORMATS.has(value as ClinVarSourceFormat)) {
    throw new ClinVarTemporalInputError(`rawSource.format must be one of ${[...SOURCE_FORMATS].join(", ")}`);
  }
  return value as ClinVarSourceFormat;
}

function normalizeParser(input: ClinVarParserIdentity): ClinVarParserIdentity {
  return {
    id: assertText("parser.id", input?.id),
    version: assertText("parser.version", input?.version),
    implementationDigest: assertDigest("parser.implementationDigest", input?.implementationDigest),
  };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function canonicalJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  ) as JsonValue;
}

function canonicalJsonBytes(value: JsonValue): Buffer {
  return Buffer.from(JSON.stringify(canonicalJson(value)), "utf8");
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
}

function casAddress(digest: `sha256:${string}`): { algorithm: "sha256"; digest: string } {
  return { algorithm: "sha256", digest: digest.slice("sha256:".length) };
}

async function putCas(cas: CasStore, bytes: Uint8Array, mediaType: string): Promise<{ digest: `sha256:${string}`; uri: `cas:sha256:${string}`; sizeBytes: number }> {
  const digest = sha256(bytes);
  await cas.put({ ...casAddress(digest), sizeBytes: bytes.length, mediaType }, Buffer.from(bytes));
  return { digest, uri: `cas:${digest}`, sizeBytes: bytes.length };
}

function releaseStatementKey(lakeId: string, releaseId: string): string {
  return `clinvar-release:${lakeId}:${releaseId}`;
}

function releaseNode(lakeId: string, releaseId: string): string {
  return `clinvar-release:${lakeId}:${releaseId}`;
}

function normalizeLake(config: ClinVarDuckLakeConfig): ClinVarDuckLakeConfig {
  const lakeId = assertLakeId(config.lakeId);
  const catalogPath = assertText("catalogPath", config.catalogPath);
  const dataPath = assertText("dataPath", config.dataPath);
  const resolvedCatalog = resolve(catalogPath);
  const resolvedData = resolve(dataPath);
  if (resolvedCatalog === resolvedData) throw new ClinVarTemporalInputError("catalogPath and dataPath must differ");
  return { lakeId, catalogPath: resolvedCatalog, dataPath: resolvedData };
}

/**
 * The configuration digest distinguishes host-attached catalogs with the same logical lake id and snapshot number
 * without putting host paths into a manifest, result, or replay artifact.
 */
function duckLakeConfigDigest(config: ClinVarDuckLakeConfig): `sha256:${string}` {
  const lake = normalizeLake(config);
  return canonicalDigest({
    schema: "pi-bio.workbench.ducklake_config.v1",
    lake_id: lake.lakeId,
    catalog_path: lake.catalogPath,
    data_path: lake.dataPath,
  }) as `sha256:${string}`;
}

/** The default is a local DuckLake catalog under the workbench workspace, separate from the one observation ledger. */
export function defaultClinVarDuckLakeConfig(workspace: string): ClinVarDuckLakeConfig {
  const root = resolve(workspace, ".pi", "bio-agent", "clinvar");
  return { lakeId: "clinvar", catalogPath: join(root, "catalog.ducklake"), dataPath: join(root, "data") };
}

function normalizeAssertions(input: readonly ClinVarAssertionInput[]): NormalizedClinVarAssertion[] {
  if (input.length === 0) throw new ClinVarTemporalInputError("a ClinVar release requires at least one normalized assertion");
  const assertionIds = new Set<string>();
  const temporalKeys = new Set<string>();
  const scopes = new Set<string>(["variation_aggregate", "condition_aggregate", "submission"]);
  const normalized = input.map((inputItem) => {
    if (!inputItem || typeof inputItem !== "object" || Array.isArray(inputItem)) {
      throw new ClinVarTemporalInputError("each normalized ClinVar assertion must be an object");
    }
    const item = inputItem as ClinVarAssertionInput;
    const assertionId = assertText("assertionId", item.assertionId);
    if (assertionIds.has(assertionId)) throw new ClinVarTemporalInputError(`duplicate assertionId '${assertionId}' in one release`);
    assertionIds.add(assertionId);
    const temporalKey = assertText("temporalKey", item.temporalKey);
    if (temporalKeys.has(temporalKey)) throw new ClinVarTemporalInputError(`duplicate temporalKey '${temporalKey}' in one release`);
    temporalKeys.add(temporalKey);
    if (!scopes.has(item.recordScope)) throw new ClinVarTemporalInputError(`unsupported recordScope '${String(item.recordScope)}'`);
    const rawGeneIds = item.geneIds ?? [];
    if (!Array.isArray(rawGeneIds)) throw new ClinVarTemporalInputError("geneIds must be an array when supplied");
    const geneIds = [...new Set(rawGeneIds.map((geneId) => assertText("geneId", geneId)))].sort();
    if (item.attributes !== undefined && (!item.attributes || typeof item.attributes !== "object" || Array.isArray(item.attributes))) {
      throw new ClinVarTemporalInputError("attributes must be an object when supplied");
    }
    return {
      assertionId,
      temporalKey,
      recordScope: item.recordScope,
      variationId: assertText("variationId", item.variationId),
      ...(item.conditionId ? { conditionId: assertText("conditionId", item.conditionId) } : {}),
      ...(item.conditionLabel ? { conditionLabel: assertText("conditionLabel", item.conditionLabel) } : {}),
      geneIds,
      clinicalSignificance: assertText("clinicalSignificance", item.clinicalSignificance),
      ...(item.reviewStatus ? { reviewStatus: assertText("reviewStatus", item.reviewStatus) } : {}),
      ...(item.submitter ? { submitter: assertText("submitter", item.submitter) } : {}),
      ...(item.lastEvaluated ? { lastEvaluated: assertText("lastEvaluated", item.lastEvaluated) } : {}),
      ...(item.attributes ? { attributes: canonicalJson(item.attributes) as Record<string, JsonValue> } : {}),
    } satisfies NormalizedClinVarAssertion;
  });
  return normalized.sort((left, right) => left.assertionId.localeCompare(right.assertionId));
}

function temporalTaskStatementKey(taskId: string): string {
  return `clinvar-temporal-task:${taskId}`;
}

function temporalTaskNode(taskId: string): string {
  return `clinvar-temporal-task:${taskId}`;
}

function temporalEvaluationStatementKey(taskId: string): string {
  return `clinvar-temporal-evaluation:${taskId}`;
}

function temporalEvaluationNode(taskId: string): string {
  return `clinvar-temporal-evaluation:${taskId}`;
}

function releaseBaseline(release: ClinVarRelease): ClinVarTemporalTaskBaseline {
  return {
    lakeId: release.lakeId,
    releaseId: release.releaseId,
    releasedAt: release.releasedAt,
    releaseDigest: release.releaseDigest,
    normalizedDigest: release.normalizedDigest,
    duckLakeSnapshotId: release.duckLakeSnapshotId,
    duckLakeConfigDigest: release.duckLakeConfigDigest,
  };
}

function releaseFromBaseline(release: ClinVarRelease, baseline: ClinVarTemporalTaskBaseline): boolean {
  return release.lakeId === baseline.lakeId
    && release.releaseId === baseline.releaseId
    && release.releasedAt === baseline.releasedAt
    && release.releaseDigest === baseline.releaseDigest
    && release.normalizedDigest === baseline.normalizedDigest
    && release.duckLakeSnapshotId === baseline.duckLakeSnapshotId
    && release.duckLakeConfigDigest === baseline.duckLakeConfigDigest;
}

/** Create evaluator-only entropy for a temporal target commitment. Persist it only in evaluator CAS. */
export function createClinVarTemporalCommitmentSecret(): Buffer {
  return randomBytes(32);
}

function normalizeCommitmentSecret(value: Buffer | Uint8Array): Buffer {
  const secret = Buffer.from(value);
  if (secret.length < 32) {
    throw new ClinVarTemporalInputError("targetCommitmentSecret must contain at least 32 bytes of evaluator-only entropy");
  }
  return secret;
}

function normalizeCandidatePolicyValues(label: string, input: unknown, required: boolean): string[] {
  if (input === undefined && !required) return [];
  if (!Array.isArray(input)) throw new ClinVarTemporalInputError(`${label} must be an array of source labels`);
  const values = [...new Set(input.map((value) => assertText(label, value)))].sort();
  if (required && values.length === 0) throw new ClinVarTemporalInputError(`${label} requires at least one source label`);
  return values;
}

function normalizedCandidatePolicy(input: unknown): ClinVarTemporalTask["candidatePolicy"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClinVarTemporalInputError("candidatePolicy must be an object");
  }
  const policy = input as Record<string, unknown>;
  const baselineClinicalSignificances = normalizeCandidatePolicyValues(
    "candidatePolicy.baselineClinicalSignificances",
    policy.baselineClinicalSignificances,
    true,
  );
  const baselineReviewStatuses = normalizeCandidatePolicyValues(
    "candidatePolicy.baselineReviewStatuses",
    policy.baselineReviewStatuses,
    false,
  );
  return {
    baselineClinicalSignificances,
    ...(baselineReviewStatuses.length ? { baselineReviewStatuses } : {}),
  };
}

function isolationReceiptBody(receipt: Omit<ClinVarTemporalIsolationReceipt, "policyDigest">): Record<string, string> {
  return {
    schema: receipt.schema,
    mode: receipt.mode,
    agent_boundary_id: receipt.agentBoundaryId,
    evaluator_boundary_id: receipt.evaluatorBoundaryId,
    target_access: receipt.targetAccess,
  };
}

/**
 * Produce the canonical, secret-free receipt shape for a host that has already provisioned an actual isolation
 * boundary. Calling this helper alone does not create process, filesystem, network, or tool isolation.
 */
export function buildClinVarTemporalIsolationReceipt(input: Omit<ClinVarTemporalIsolationReceipt, "schema" | "policyDigest">): ClinVarTemporalIsolationReceipt {
  const receipt: Omit<ClinVarTemporalIsolationReceipt, "policyDigest"> = {
    schema: CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA,
    mode: input.mode,
    agentBoundaryId: input.agentBoundaryId,
    evaluatorBoundaryId: input.evaluatorBoundaryId,
    targetAccess: input.targetAccess,
  };
  return { ...receipt, policyDigest: canonicalDigest(isolationReceiptBody(receipt)) };
}

function validateClinVarTemporalIsolationReceipt(input: ClinVarTemporalIsolationReceipt): ClinVarTemporalIsolationReceipt {
  const receipt = input as unknown as Record<string, unknown>;
  if (receipt.schema !== CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA) {
    throw new ClinVarTemporalInputError(`isolationReceipt.schema must be '${CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA}'`);
  }
  if (receipt.mode !== "host_enforced") throw new ClinVarTemporalInputError("isolationReceipt.mode must be 'host_enforced'");
  if (receipt.targetAccess !== "evaluator_only") throw new ClinVarTemporalInputError("isolationReceipt.targetAccess must be 'evaluator_only'");
  const agentBoundaryId = assertBoundaryId("isolationReceipt.agentBoundaryId", receipt.agentBoundaryId);
  const evaluatorBoundaryId = assertBoundaryId("isolationReceipt.evaluatorBoundaryId", receipt.evaluatorBoundaryId);
  if (agentBoundaryId === evaluatorBoundaryId) throw new ClinVarTemporalInputError("agent and evaluator boundaries must differ");
  const policyDigest = assertDigest("isolationReceipt.policyDigest", receipt.policyDigest);
  const body: Omit<ClinVarTemporalIsolationReceipt, "policyDigest"> = {
    schema: CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA,
    mode: "host_enforced",
    agentBoundaryId,
    evaluatorBoundaryId,
    targetAccess: "evaluator_only",
  };
  if (policyDigest !== canonicalDigest(isolationReceiptBody(body))) {
    throw new ClinVarTemporalInputError("isolationReceipt.policyDigest does not match its declared isolation policy");
  }
  return { ...body, policyDigest };
}

function pathContains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function assertSeparateTemporalBoundaries(
  evaluatorWorkspace: string,
  agentWorkspace: string,
  evaluatorLake: ClinVarDuckLakeConfig,
  agentLake: ClinVarDuckLakeConfig,
): void {
  const evaluatorRoot = resolve(assertText("evaluatorWorkspace", evaluatorWorkspace));
  const agentRoot = resolve(assertText("agentWorkspace", agentWorkspace));
  if (pathContains(evaluatorRoot, agentRoot) || pathContains(agentRoot, evaluatorRoot)) {
    throw new ClinVarTemporalInputError("agentWorkspace and evaluatorWorkspace must be non-overlapping host boundaries");
  }
  const evaluatorPaths = [evaluatorLake.catalogPath, evaluatorLake.dataPath];
  const agentPaths = [agentLake.catalogPath, agentLake.dataPath];
  if (evaluatorPaths.some((evaluatorPath) => agentPaths.some((agentPath) => (
    pathContains(evaluatorPath, agentPath) || pathContains(agentPath, evaluatorPath)
  )))) {
    throw new ClinVarTemporalInputError("agent and evaluator DuckLake catalog/data paths must be non-overlapping");
  }
}

/**
 * A task boundary cannot reuse an arbitrary catalog. A catalog with another release could reveal target labels even
 * though the task artifact contains only a baseline commitment. Reusing the exact normalized baseline is safe and
 * makes an interrupted task preparation idempotent.
 */
async function assertAgentLakeIsBaselineOnly(
  lake: ClinVarDuckLakeConfig,
  baseline: ClinVarRelease,
  expectedNormalized: NormalizedRelease,
): Promise<void> {
  if (!(await exists(lake.catalogPath))) return;
  await withDuckLake(lake, { readOnly: true }, async (conn) => {
    const tables = await conn.all<{ table_name: string }>(
      `SELECT table_name
       FROM duckdb_tables()
       WHERE database_name = ?
         AND schema_name = 'main'
         AND table_name IN ('clinvar_releases', 'clinvar_assertions')`,
      [CATALOG_ALIAS],
    );
    const names = new Set(tables.map((table) => table.table_name));
    if (names.size === 0) return;
    if (!names.has("clinvar_releases") || !names.has("clinvar_assertions")) {
      throw new ClinVarTemporalInputError("agent DuckLake has incomplete ClinVar tables and cannot prove a baseline-only boundary");
    }
    const [releases, assertionRows] = await Promise.all([
      conn.all<{
        release_id: string;
        released_at_epoch_ms: number | bigint;
        raw_digest: string;
        normalized_digest: string;
        parser_id: string;
        parser_version: string;
        parser_digest: string;
        assertion_count: number | bigint;
      }>(
        `SELECT release_id, epoch_ms(released_at) AS released_at_epoch_ms, raw_digest, normalized_digest,
                parser_id, parser_version, parser_digest, assertion_count
         FROM ${CATALOG_ALIAS}.clinvar_releases
         ORDER BY release_id`,
      ),
      conn.all<{
        release_id: string;
        assertion_id: string;
        temporal_key: string;
        record_scope: string;
        variation_id: string;
        condition_id: string | null;
        condition_label: string | null;
        gene_ids_json: string;
        clinical_significance: string;
        review_status: string | null;
        submitter: string | null;
        last_evaluated: string | null;
        attributes_json: string | null;
      }>(
        `SELECT release_id, assertion_id, temporal_key, record_scope, variation_id, condition_id, condition_label,
                gene_ids_json, clinical_significance, review_status, submitter, last_evaluated, attributes_json
         FROM ${CATALOG_ALIAS}.clinvar_assertions
         ORDER BY release_id, assertion_id`,
      ),
    ]);
    if (releases.length === 0 && assertionRows.length === 0) return;
    const release = releases[0];
    const releasedAtEpochMs = release && typeof release.released_at_epoch_ms === "bigint"
      ? Number(release.released_at_epoch_ms)
      : release?.released_at_epoch_ms;
    const assertionCount = release && typeof release.assertion_count === "bigint"
      ? Number(release.assertion_count)
      : release?.assertion_count;
    const expectedReleasedAtEpochMs = Date.parse(baseline.releasedAt);
    const matchingRelease = releases.length === 1
      && release?.release_id === baseline.releaseId
      && releasedAtEpochMs === expectedReleasedAtEpochMs
      && release.raw_digest === baseline.rawDigest
      && release.normalized_digest === baseline.normalizedDigest
      && release.parser_id === baseline.parser.id
      && release.parser_version === baseline.parser.version
      && release.parser_digest === baseline.parser.implementationDigest
      && assertionCount === baseline.assertionCount
      && assertionRows.length === baseline.assertionCount
      && assertionRows.every((row) => row.release_id === baseline.releaseId);
    if (!matchingRelease) {
      throw new ClinVarTemporalInputError("agent DuckLake must be empty or contain only the exact baseline release");
    }
    const parseStringArray = (label: string, value: string): string[] => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new ClinVarTemporalInputError(`${label} is not valid JSON`);
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new ClinVarTemporalInputError(`${label} must be a JSON string array`);
      }
      return parsed;
    };
    const parseAttributes = (label: string, value: string): Record<string, JsonValue> => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new ClinVarTemporalInputError(`${label} is not valid JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ClinVarTemporalInputError(`${label} must be a JSON object`);
      }
      return parsed as Record<string, JsonValue>;
    };
    let normalizedAssertions: NormalizedClinVarAssertion[];
    try {
      normalizedAssertions = normalizeAssertions(assertionRows.map((row) => ({
        assertionId: row.assertion_id,
        temporalKey: row.temporal_key,
        recordScope: row.record_scope as ClinVarRecordScope,
        variationId: row.variation_id,
        ...(row.condition_id === null ? {} : { conditionId: row.condition_id }),
        ...(row.condition_label === null ? {} : { conditionLabel: row.condition_label }),
        geneIds: parseStringArray(`agent DuckLake assertion '${row.assertion_id}' gene_ids_json`, row.gene_ids_json),
        clinicalSignificance: row.clinical_significance,
        ...(row.review_status === null ? {} : { reviewStatus: row.review_status }),
        ...(row.submitter === null ? {} : { submitter: row.submitter }),
        ...(row.last_evaluated === null ? {} : { lastEvaluated: row.last_evaluated }),
        ...(row.attributes_json === null ? {} : {
          attributes: parseAttributes(`agent DuckLake assertion '${row.assertion_id}' attributes_json`, row.attributes_json),
        }),
      })));
    } catch (error: unknown) {
      if (error instanceof ClinVarTemporalInputError) throw error;
      throw new ClinVarTemporalInputError(`agent DuckLake assertions cannot be normalized: ${String(error)}`);
    }
    const normalizedFromLake: NormalizedRelease = {
      schema: CLINVAR_NORMALIZED_RELEASE_SCHEMA,
      releaseId: baseline.releaseId,
      releasedAt: baseline.releasedAt,
      parser: baseline.parser,
      assertions: normalizedAssertions,
    };
    const normalizedDigest = sha256(canonicalJsonBytes(normalizedFromLake as unknown as JsonValue));
    if (
      expectedNormalized.releaseId !== baseline.releaseId
      || expectedNormalized.releasedAt !== baseline.releasedAt
      || expectedNormalized.parser.id !== baseline.parser.id
      || expectedNormalized.parser.version !== baseline.parser.version
      || expectedNormalized.parser.implementationDigest !== baseline.parser.implementationDigest
      || normalizedDigest !== baseline.normalizedDigest
    ) {
      throw new ClinVarTemporalInputError("agent DuckLake assertions do not match the exact normalized baseline release");
    }
  });
}

function targetCommitment(
  target: Pick<ClinVarTemporalTaskBaseline, "releaseDigest" | "normalizedDigest" | "duckLakeSnapshotId" | "duckLakeConfigDigest">,
  secret: Buffer | Uint8Array,
): `sha256:${string}` {
  const body = canonicalJsonBytes({
    schema: "pi-bio.workbench.clinvar_temporal_target_commitment.v1",
    release_digest: target.releaseDigest,
    normalized_digest: target.normalizedDigest,
    ducklake_snapshot_id: target.duckLakeSnapshotId,
    ducklake_config_digest: target.duckLakeConfigDigest,
  });
  return `sha256:${createHmac("sha256", normalizeCommitmentSecret(secret)).update(body).digest("hex")}`;
}

function assertReleaseOrder(baseline: ClinVarRelease, target: ClinVarRelease): void {
  const baselineReleasedAt = Date.parse(assertTimestamp("baseline.releasedAt", baseline.releasedAt));
  const targetReleasedAt = Date.parse(assertTimestamp("target.releasedAt", target.releasedAt));
  if (targetReleasedAt <= baselineReleasedAt) {
    throw new ClinVarTemporalInputError("target release must be later than the baseline release");
  }
  if (target.duckLakeSnapshotId < baseline.duckLakeSnapshotId) {
    throw new ClinVarTemporalInputError("target DuckLake snapshot predates the baseline; import releases chronologically or create a dedicated ordered catalog");
  }
}

function parseLedgerValue(valueJson: string): ReleaseLedgerValue {
  const item = asObject("ClinVar release ledger value", JSON.parse(valueJson));
  if (item.schema !== CLINVAR_RELEASE_SCHEMA) throw new Error("ClinVar release ledger value has an invalid schema");
  if (typeof item.assertion_count !== "number" || !Number.isSafeInteger(item.assertion_count) || item.assertion_count < 1) {
    throw new Error("ClinVar release ledger value has an invalid assertion_count");
  }
  if (typeof item.ducklake_snapshot_id !== "number" || !Number.isSafeInteger(item.ducklake_snapshot_id) || item.ducklake_snapshot_id < 0) {
    throw new Error("ClinVar release ledger value has an invalid ducklake_snapshot_id");
  }
  return {
    schema: CLINVAR_RELEASE_SCHEMA,
    lake_id: assertLakeId(item.lake_id),
    release_id: assertReleaseId(item.release_id),
    released_at: assertTimestamp("released_at", item.released_at),
    source_uri: assertText("source_uri", item.source_uri),
    source_format: assertSourceFormat(item.source_format),
    raw_digest: assertDigest("raw_digest", item.raw_digest),
    raw_uri: assertCasUri("raw_uri", item.raw_uri),
    raw_media_type: assertMediaType("raw_media_type", item.raw_media_type, RAW_MEDIA_TYPE),
    normalized_digest: assertDigest("normalized_digest", item.normalized_digest),
    normalized_uri: assertCasUri("normalized_uri", item.normalized_uri),
    parser_id: assertText("parser_id", item.parser_id),
    parser_version: assertText("parser_version", item.parser_version),
    parser_digest: assertDigest("parser_digest", item.parser_digest),
    assertion_count: item.assertion_count,
    ducklake_snapshot_id: item.ducklake_snapshot_id,
    ducklake_config_digest: assertDigest("ducklake_config_digest", item.ducklake_config_digest),
    release_digest: assertDigest("release_digest", item.release_digest),
  };
}

function releaseFromValue(value: ReleaseLedgerValue, recordedAt: string): ClinVarRelease {
  return {
    schema: CLINVAR_RELEASE_SCHEMA,
    lakeId: value.lake_id,
    releaseId: value.release_id,
    releasedAt: value.released_at,
    sourceUri: value.source_uri,
    sourceFormat: value.source_format,
    rawDigest: value.raw_digest,
    rawUri: value.raw_uri,
    rawMediaType: value.raw_media_type,
    normalizedDigest: value.normalized_digest,
    normalizedUri: value.normalized_uri,
    parser: { id: value.parser_id, version: value.parser_version, implementationDigest: value.parser_digest },
    assertionCount: value.assertion_count,
    duckLakeSnapshotId: value.ducklake_snapshot_id,
    duckLakeConfigDigest: value.ducklake_config_digest,
    releaseDigest: value.release_digest,
    recordedAt,
  };
}

async function readReleaseFromLedger(
  conn: SqlConn,
  lakeId: string,
  releaseId: string,
  asOf = AS_OF,
): Promise<ClinVarRelease | null> {
  const observation = await observationAsOfKey(conn, releaseStatementKey(lakeId, releaseId), asOf);
  if (!observation?.value_json) return null;
  const value = parseLedgerValue(observation.value_json);
  if (value.lake_id !== lakeId || value.release_id !== releaseId) throw new Error("ClinVar release ledger identity mismatch");
  return releaseFromValue(value, observation.recorded_at);
}

function asObject(label: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClinVarTemporalInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function taskBaselineFromUnknown(label: string, value: unknown): ClinVarTemporalTaskBaseline {
  const item = asObject(label, value);
  const duckLakeSnapshotId = item.duckLakeSnapshotId;
  if (typeof duckLakeSnapshotId !== "number" || !Number.isSafeInteger(duckLakeSnapshotId) || duckLakeSnapshotId < 0) {
    throw new ClinVarTemporalInputError(`${label}.duckLakeSnapshotId must be a non-negative safe integer`);
  }
  return {
    lakeId: assertLakeId(item.lakeId),
    releaseId: assertReleaseId(item.releaseId),
    releasedAt: assertTimestamp(`${label}.releasedAt`, item.releasedAt),
    releaseDigest: assertDigest(`${label}.releaseDigest`, item.releaseDigest),
    normalizedDigest: assertDigest(`${label}.normalizedDigest`, item.normalizedDigest),
    duckLakeSnapshotId,
    duckLakeConfigDigest: assertDigest(`${label}.duckLakeConfigDigest`, item.duckLakeConfigDigest),
  };
}

function temporalTaskIdentity(input: Omit<ClinVarTemporalTask, "taskDigest">): Record<string, unknown> {
  return {
    schema: CLINVAR_TEMPORAL_TASK_SCHEMA,
    task_id: input.taskId,
    agent_baseline: {
      lake_id: input.agentBaseline.lakeId,
      release_id: input.agentBaseline.releaseId,
      released_at: input.agentBaseline.releasedAt,
      release_digest: input.agentBaseline.releaseDigest,
      normalized_digest: input.agentBaseline.normalizedDigest,
      ducklake_snapshot_id: input.agentBaseline.duckLakeSnapshotId,
      ducklake_config_digest: input.agentBaseline.duckLakeConfigDigest,
    },
    candidate_policy: {
      baseline_clinical_significances: input.candidatePolicy.baselineClinicalSignificances,
      baseline_review_statuses: input.candidatePolicy.baselineReviewStatuses ?? [],
    },
    target_commitment: input.targetCommitment,
    isolation: isolationReceiptBody(input.isolation),
  };
}

function temporalTaskDigest(input: Omit<ClinVarTemporalTask, "taskDigest">): `sha256:${string}` {
  return canonicalDigest(temporalTaskIdentity(input));
}

function parseTemporalTask(value: unknown): ClinVarTemporalTask {
  const item = asObject("ClinVar temporal task", value);
  if (item.schema !== CLINVAR_TEMPORAL_TASK_SCHEMA) {
    throw new ClinVarTemporalInputError("ClinVar temporal task has an unsupported schema");
  }
  const task: ClinVarTemporalTask = {
    schema: CLINVAR_TEMPORAL_TASK_SCHEMA,
    taskId: assertTaskId(item.taskId),
    agentBaseline: taskBaselineFromUnknown("task.agentBaseline", item.agentBaseline),
    candidatePolicy: normalizedCandidatePolicy(item.candidatePolicy),
    targetCommitment: assertDigest("task.targetCommitment", item.targetCommitment),
    isolation: validateClinVarTemporalIsolationReceipt(item.isolation as ClinVarTemporalIsolationReceipt),
    taskDigest: assertDigest("task.taskDigest", item.taskDigest),
  };
  if (task.taskDigest !== temporalTaskDigest(task)) {
    throw new ClinVarTemporalInputError("ClinVar temporal task digest does not match its content");
  }
  return task;
}

function parseTaskLedgerValue(valueJson: string): TemporalTaskLedgerValue {
  const item = asObject("ClinVar temporal task ledger value", JSON.parse(valueJson));
  if (item.schema !== CLINVAR_TEMPORAL_TASK_SCHEMA) throw new Error("ClinVar temporal task ledger value has an invalid schema");
  return {
    schema: CLINVAR_TEMPORAL_TASK_SCHEMA,
    task_id: assertTaskId(item.task_id),
    task_digest: assertDigest("task_digest", item.task_digest),
    task_artifact_digest: assertDigest("task_artifact_digest", item.task_artifact_digest),
    task_artifact_uri: assertCasUri("task_artifact_uri", item.task_artifact_uri),
    agent_lake_id: assertLakeId(item.agent_lake_id),
    agent_release_id: assertReleaseId(item.agent_release_id),
    agent_release_digest: assertDigest("agent_release_digest", item.agent_release_digest),
    agent_lake_config_digest: assertDigest("agent_lake_config_digest", item.agent_lake_config_digest),
    target_commitment: assertDigest("target_commitment", item.target_commitment),
    isolation_policy_digest: assertDigest("isolation_policy_digest", item.isolation_policy_digest),
  };
}

function parseEvaluationLedgerValue(valueJson: string): TemporalEvaluationLedgerValue {
  const item = asObject("ClinVar temporal evaluation ledger value", JSON.parse(valueJson));
  if (item.schema !== CLINVAR_TEMPORAL_EVALUATION_SCHEMA) throw new Error("ClinVar temporal evaluation ledger value has an invalid schema");
  return {
    schema: CLINVAR_TEMPORAL_EVALUATION_SCHEMA,
    task_id: assertTaskId(item.task_id),
    task_digest: assertDigest("task_digest", item.task_digest),
    evaluator_baseline_lake_id: assertLakeId(item.evaluator_baseline_lake_id),
    evaluator_baseline_release_id: assertReleaseId(item.evaluator_baseline_release_id),
    evaluator_baseline_release_digest: assertDigest("evaluator_baseline_release_digest", item.evaluator_baseline_release_digest),
    evaluator_baseline_lake_config_digest: assertDigest("evaluator_baseline_lake_config_digest", item.evaluator_baseline_lake_config_digest),
    target_lake_id: assertLakeId(item.target_lake_id),
    target_release_id: assertReleaseId(item.target_release_id),
    target_release_digest: assertDigest("target_release_digest", item.target_release_digest),
    target_lake_config_digest: assertDigest("target_lake_config_digest", item.target_lake_config_digest),
    target_commitment: assertDigest("target_commitment", item.target_commitment),
    target_commitment_secret_digest: assertDigest("target_commitment_secret_digest", item.target_commitment_secret_digest),
    target_commitment_secret_uri: assertCasUri("target_commitment_secret_uri", item.target_commitment_secret_uri),
    isolation_schema: item.isolation_schema === CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA
      ? CLINVAR_TEMPORAL_ISOLATION_RECEIPT_SCHEMA
      : (() => { throw new ClinVarTemporalInputError("isolation_schema is invalid"); })(),
    isolation_mode: item.isolation_mode === "host_enforced"
      ? "host_enforced"
      : (() => { throw new ClinVarTemporalInputError("isolation_mode is invalid"); })(),
    agent_boundary_id: assertBoundaryId("agent_boundary_id", item.agent_boundary_id),
    evaluator_boundary_id: assertBoundaryId("evaluator_boundary_id", item.evaluator_boundary_id),
    target_access: item.target_access === "evaluator_only"
      ? "evaluator_only"
      : (() => { throw new ClinVarTemporalInputError("target_access is invalid"); })(),
    isolation_policy_digest: assertDigest("isolation_policy_digest", item.isolation_policy_digest),
  };
}

async function readVerifiedCasBytes(cas: CasStore, digest: `sha256:${string}`, label: string): Promise<Buffer> {
  const address = casAddress(digest);
  if (!(await cas.has(address))) throw new ClinVarTemporalInputError(`${label} is missing from CAS`);
  const bytes = await fs.readFile(cas.pathFor(address));
  if (sha256(bytes) !== digest) throw new ClinVarTemporalInputError(`${label} does not match its CAS digest`);
  return bytes;
}

function parseNormalizedRelease(value: unknown): NormalizedRelease {
  const item = asObject("normalized ClinVar release", value);
  if (item.schema !== CLINVAR_NORMALIZED_RELEASE_SCHEMA) {
    throw new ClinVarTemporalInputError("normalized ClinVar release has an unsupported schema");
  }
  const parserItem = asObject("normalized ClinVar release parser", item.parser);
  if (!Array.isArray(item.assertions)) throw new ClinVarTemporalInputError("normalized ClinVar release assertions must be an array");
  return {
    schema: CLINVAR_NORMALIZED_RELEASE_SCHEMA,
    releaseId: assertReleaseId(item.releaseId),
    releasedAt: assertTimestamp("normalized ClinVar release releasedAt", item.releasedAt),
    parser: normalizeParser(parserItem as unknown as ClinVarParserIdentity),
    assertions: normalizeAssertions(item.assertions as ClinVarAssertionInput[]),
  };
}

async function readNormalizedReleaseFromCas(cas: CasStore, release: ClinVarRelease): Promise<NormalizedRelease> {
  const bytes = await readVerifiedCasBytes(cas, release.normalizedDigest, `normalized ClinVar release '${release.releaseId}'`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ClinVarTemporalInputError(`normalized ClinVar release '${release.releaseId}' is not valid JSON`);
  }
  const normalized = parseNormalizedRelease(value);
  if (normalized.releaseId !== release.releaseId || normalized.releasedAt !== release.releasedAt
    || normalized.parser.id !== release.parser.id || normalized.parser.version !== release.parser.version
    || normalized.parser.implementationDigest !== release.parser.implementationDigest) {
    throw new ClinVarTemporalInputError(`normalized ClinVar release '${release.releaseId}' does not match its registry metadata`);
  }
  const normalizedBytes = canonicalJsonBytes(normalized as unknown as JsonValue);
  if (sha256(normalizedBytes) !== release.normalizedDigest) {
    throw new ClinVarTemporalInputError(`normalized ClinVar release '${release.releaseId}' is not canonical for its declared digest`);
  }
  return normalized;
}

async function readTemporalTaskFromLedger(
  conn: SqlConn,
  cas: CasStore,
  taskId: string,
  asOf = AS_OF,
): Promise<{ task: ClinVarTemporalTask; taskArtifactDigest: `sha256:${string}`; taskArtifactUri: `cas:sha256:${string}` } | null> {
  const observation = await observationAsOfKey(conn, temporalTaskStatementKey(taskId), asOf);
  if (!observation?.value_json) return null;
  const value = parseTaskLedgerValue(observation.value_json);
  const bytes = await readVerifiedCasBytes(cas, value.task_artifact_digest, `ClinVar temporal task '${taskId}'`);
  let taskValue: unknown;
  try {
    taskValue = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ClinVarTemporalInputError(`ClinVar temporal task '${taskId}' CAS object is not valid JSON`);
  }
  const task = parseTemporalTask(taskValue);
  if (task.taskId !== taskId || task.taskDigest !== value.task_digest || task.targetCommitment !== value.target_commitment
    || task.isolation.policyDigest !== value.isolation_policy_digest || task.agentBaseline.lakeId !== value.agent_lake_id
    || task.agentBaseline.releaseId !== value.agent_release_id || task.agentBaseline.releaseDigest !== value.agent_release_digest
    || task.agentBaseline.duckLakeConfigDigest !== value.agent_lake_config_digest) {
    throw new ClinVarTemporalInputError(`ClinVar temporal task '${taskId}' does not match its ledger metadata`);
  }
  if (value.task_artifact_uri !== `cas:${value.task_artifact_digest}`) {
    throw new ClinVarTemporalInputError(`ClinVar temporal task '${taskId}' has an invalid task artifact URI`);
  }
  return { task, taskArtifactDigest: value.task_artifact_digest, taskArtifactUri: value.task_artifact_uri };
}

async function readTemporalEvaluationFromLedger(
  conn: SqlConn,
  taskId: string,
  asOf = AS_OF,
): Promise<{ value: TemporalEvaluationLedgerValue; recordedAt: string } | null> {
  const observation = await observationAsOfKey(conn, temporalEvaluationStatementKey(taskId), asOf);
  if (!observation?.value_json) return null;
  return { value: parseEvaluationLedgerValue(observation.value_json), recordedAt: observation.recorded_at };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function withDuckLake<T>(
  config: ClinVarDuckLakeConfig,
  options: { readOnly: boolean; snapshotVersion?: number },
  fn: (conn: SqlConn) => Promise<T>,
): Promise<T> {
  const lake = normalizeLake(config);
  if (options.snapshotVersion !== undefined && (!Number.isInteger(options.snapshotVersion) || options.snapshotVersion < 0)) {
    throw new ClinVarTemporalInputError("DuckLake snapshotVersion must be a non-negative integer");
  }
  const catalogExists = await exists(lake.catalogPath);
  if (options.readOnly && !catalogExists) throw new ClinVarTemporalInputError(`DuckLake catalog '${lake.lakeId}' does not exist`);
  if (!catalogExists) {
    await fs.mkdir(dirname(lake.catalogPath), { recursive: true });
    await fs.mkdir(lake.dataPath, { recursive: true });
  }
  const instance = await DuckDBInstance.create(":memory:");
  let connection: Awaited<ReturnType<typeof instance.connect>> | undefined;
  try {
    connection = await instance.connect();
    const conn = duckdbNodeConn(connection);
    await conn.run("LOAD ducklake");
    const attachOptions = [
      ...(options.readOnly ? ["READ_ONLY"] : []),
      ...(options.snapshotVersion === undefined ? [] : [`SNAPSHOT_VERSION ${options.snapshotVersion}`]),
      ...(!catalogExists ? [`DATA_PATH ${sqlString(lake.dataPath)}`] : []),
    ];
    await conn.run(`ATTACH ${sqlString(`ducklake:${lake.catalogPath}`)} AS ${CATALOG_ALIAS}${attachOptions.length ? ` (${attachOptions.join(", ")})` : ""}`);
    return await fn(conn);
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

async function ensureDuckLakeTables(conn: SqlConn): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS ${CATALOG_ALIAS}.clinvar_releases (
    release_id VARCHAR,
    released_at TIMESTAMPTZ,
    source_uri VARCHAR,
    source_format VARCHAR,
    raw_digest VARCHAR,
    raw_media_type VARCHAR,
    normalized_digest VARCHAR,
    parser_id VARCHAR,
    parser_version VARCHAR,
    parser_digest VARCHAR,
    assertion_count BIGINT,
    release_digest VARCHAR,
    ducklake_snapshot_id BIGINT,
    registered_at TIMESTAMPTZ
  )`);
  await conn.run(`CREATE TABLE IF NOT EXISTS ${CATALOG_ALIAS}.clinvar_assertions (
    release_id VARCHAR,
    assertion_id VARCHAR,
    temporal_key VARCHAR,
    record_scope VARCHAR,
    variation_id VARCHAR,
    condition_id VARCHAR,
    condition_label VARCHAR,
    gene_ids_json VARCHAR,
    clinical_significance VARCHAR,
    review_status VARCHAR,
    submitter VARCHAR,
    last_evaluated VARCHAR,
    attributes_json VARCHAR
  )`);
}

function snapshotNumber(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`DuckLake returned an invalid snapshot id '${String(value)}'`);
  }
  return number;
}

async function lastCommittedSnapshot(conn: SqlConn): Promise<number> {
  const [row] = await conn.all<{ id: number | bigint | null }>(`SELECT id FROM ${CATALOG_ALIAS}.last_committed_snapshot()`);
  if (!row || row.id === null) throw new Error("DuckLake did not report a committed snapshot for the release import");
  return snapshotNumber(row.id);
}

async function transaction(conn: SqlConn, action: () => Promise<void>): Promise<void> {
  await conn.run("BEGIN");
  try {
    await action();
    await conn.run("COMMIT");
  } catch (error) {
    try {
      await conn.run("ROLLBACK");
    } catch {
      // Preserve the original error; an interrupted DuckDB connection may already have rolled back.
    }
    throw error;
  }
}

function importCommitMessage(releaseId: string, releaseDigest: string): string {
  return `ClinVar release ${releaseId} ${releaseDigest}`;
}

async function recoverSnapshotAnchor(conn: SqlConn, releaseId: string, releaseDigest: string): Promise<number> {
  const [snapshot] = await conn.all<{ snapshot_id: number | bigint }>(
    `SELECT snapshot_id FROM ${CATALOG_ALIAS}.snapshots()
     WHERE commit_message = ?
     ORDER BY snapshot_id DESC
     LIMIT 1`,
    [importCommitMessage(releaseId, releaseDigest)],
  );
  if (!snapshot) {
    throw new Error(`ClinVar release '${releaseId}' exists in DuckLake without a recoverable snapshot anchor`);
  }
  const snapshotId = snapshotNumber(snapshot.snapshot_id);
  await transaction(conn, async () => {
    await conn.run(
      `UPDATE ${CATALOG_ALIAS}.clinvar_releases
       SET ducklake_snapshot_id = ?
       WHERE release_id = ? AND release_digest = ? AND ducklake_snapshot_id IS NULL`,
      [snapshotId, releaseId, releaseDigest],
    );
    await conn.run(`CALL ${CATALOG_ALIAS}.set_commit_message(${sqlString(SOURCE)}, ${sqlString(`Anchored ClinVar release ${releaseId}`)})`);
  });
  return snapshotId;
}

async function ingestDuckLakeRelease(args: {
  lake: ClinVarDuckLakeConfig;
  releaseId: string;
  releasedAt: string;
  sourceUri: string;
  sourceFormat: ClinVarSourceFormat;
  rawDigest: `sha256:${string}`;
  rawMediaType: string;
  normalizedDigest: `sha256:${string}`;
  parser: ClinVarParserIdentity;
  assertionCount: number;
  releaseDigest: `sha256:${string}`;
  registeredAt: string;
  assertions: readonly NormalizedClinVarAssertion[];
}): Promise<number> {
  return withDuckLake(args.lake, { readOnly: false }, async (conn) => {
    await ensureDuckLakeTables(conn);
    await conn.all("SELECT ?::TIMESTAMPTZ AS released_at", [args.releasedAt]);
    const existing = await conn.all<{
      release_digest: string;
      raw_digest: string;
      normalized_digest: string;
      ducklake_snapshot_id: number | bigint | null;
    }>(
      `SELECT release_digest, raw_digest, normalized_digest, ducklake_snapshot_id
       FROM ${CATALOG_ALIAS}.clinvar_releases WHERE release_id = ?`,
      [args.releaseId],
    );
    if (existing.length > 1) throw new Error(`DuckLake has multiple rows for ClinVar release '${args.releaseId}'`);
    if (existing[0]) {
      const row = existing[0];
      if (row.release_digest !== args.releaseDigest || row.raw_digest !== args.rawDigest || row.normalized_digest !== args.normalizedDigest) {
        throw new ClinVarTemporalInputError(`ClinVar release '${args.releaseId}' already exists in DuckLake with different immutable content`);
      }
      return row.ducklake_snapshot_id === null
        ? recoverSnapshotAnchor(conn, args.releaseId, args.releaseDigest)
        : snapshotNumber(row.ducklake_snapshot_id);
    }

    const rows = JSON.stringify(args.assertions.map((item) => ({
      release_id: args.releaseId,
      assertion_id: item.assertionId,
      temporal_key: item.temporalKey,
      record_scope: item.recordScope,
      variation_id: item.variationId,
      condition_id: item.conditionId ?? null,
      condition_label: item.conditionLabel ?? null,
      gene_ids_json: JSON.stringify(item.geneIds),
      clinical_significance: item.clinicalSignificance,
      review_status: item.reviewStatus ?? null,
      submitter: item.submitter ?? null,
      last_evaluated: item.lastEvaluated ?? null,
      attributes_json: item.attributes ? JSON.stringify(item.attributes) : null,
    })));
    await transaction(conn, async () => {
      await conn.run(
        `INSERT INTO ${CATALOG_ALIAS}.clinvar_releases (
          release_id, released_at, source_uri, source_format, raw_digest, raw_media_type, normalized_digest,
          parser_id, parser_version, parser_digest, assertion_count, release_digest, ducklake_snapshot_id, registered_at
        ) VALUES (?, ?::TIMESTAMPTZ, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?::TIMESTAMPTZ)`,
        [
          args.releaseId, args.releasedAt, args.sourceUri, args.sourceFormat, args.rawDigest, args.rawMediaType,
          args.normalizedDigest, args.parser.id, args.parser.version, args.parser.implementationDigest,
          args.assertionCount, args.releaseDigest, args.registeredAt,
        ],
      );
      await conn.run(
        `INSERT INTO ${CATALOG_ALIAS}.clinvar_assertions (
          release_id, assertion_id, temporal_key, record_scope, variation_id, condition_id, condition_label,
          gene_ids_json, clinical_significance, review_status, submitter, last_evaluated, attributes_json
        )
        SELECT
          json_extract_string(value, '$.release_id'),
          json_extract_string(value, '$.assertion_id'),
          json_extract_string(value, '$.temporal_key'),
          json_extract_string(value, '$.record_scope'),
          json_extract_string(value, '$.variation_id'),
          json_extract_string(value, '$.condition_id'),
          json_extract_string(value, '$.condition_label'),
          json_extract_string(value, '$.gene_ids_json'),
          json_extract_string(value, '$.clinical_significance'),
          json_extract_string(value, '$.review_status'),
          json_extract_string(value, '$.submitter'),
          json_extract_string(value, '$.last_evaluated'),
          json_extract_string(value, '$.attributes_json')
        FROM json_each(?::JSON)`,
        [rows],
      );
      await conn.run(`CALL ${CATALOG_ALIAS}.set_commit_message(${sqlString(SOURCE)}, ${sqlString(importCommitMessage(args.releaseId, args.releaseDigest))})`);
    });
    const snapshotId = await lastCommittedSnapshot(conn);
    // Store the import snapshot in the release relation so a ledger write interrupted after the DuckLake commit
    // can be retried without guessing which later snapshot happens to include the rows.
    await transaction(conn, async () => {
      await conn.run(
        `UPDATE ${CATALOG_ALIAS}.clinvar_releases
         SET ducklake_snapshot_id = ?
         WHERE release_id = ? AND release_digest = ? AND ducklake_snapshot_id IS NULL`,
        [snapshotId, args.releaseId, args.releaseDigest],
      );
      await conn.run(`CALL ${CATALOG_ALIAS}.set_commit_message(${sqlString(SOURCE)}, ${sqlString(`Anchored ClinVar release ${args.releaseId}`)})`);
    });
    return snapshotId;
  });
}

/**
 * Register a source-pinned ClinVar release. The caller supplies normalized rows from a separately declared parser;
 * this function neither invents an XML parser nor turns source classifications into clinical conclusions.
 */
export async function registerClinVarRelease(workspace: string, request: RegisterClinVarReleaseRequest): Promise<ClinVarRelease> {
  const lake = normalizeLake(request.lake);
  const releaseId = assertReleaseId(request.releaseId);
  const releasedAt = assertTimestamp("releasedAt", request.releasedAt);
  const sourceUri = assertText("rawSource.uri", request.rawSource.uri);
  const sourceFormat = assertSourceFormat(request.rawSource.format);
  const rawMediaType = assertMediaType("rawSource.mediaType", request.rawSource.mediaType, RAW_MEDIA_TYPE);
  const rawBytes = Buffer.from(request.rawSource.bytes);
  if (rawBytes.length === 0) throw new ClinVarTemporalInputError("rawSource.bytes must not be empty");
  const parser = normalizeParser(request.parser);
  const assertions = normalizeAssertions(request.assertions);
  const lakeConfigDigest = duckLakeConfigDigest(lake);
  const normalized: NormalizedRelease = {
    schema: CLINVAR_NORMALIZED_RELEASE_SCHEMA,
    releaseId,
    releasedAt,
    parser,
    assertions,
  };
  const normalizedBytes = canonicalJsonBytes(normalized as unknown as JsonValue);
  const rawDigest = sha256(rawBytes);
  const normalizedDigest = sha256(normalizedBytes);
  const releaseDigest = canonicalDigest({
    schema: CLINVAR_RELEASE_SCHEMA,
    lake_id: lake.lakeId,
    release_id: releaseId,
    released_at: releasedAt,
    source_uri: sourceUri,
    source_format: sourceFormat,
    raw_digest: rawDigest,
    normalized_digest: normalizedDigest,
    parser,
    assertion_count: assertions.length,
    ducklake_config_digest: lakeConfigDigest,
  }) as `sha256:${string}`;
  const recordedAt = assertTimestamp("recordedAt", request.recordedAt ?? new Date().toISOString());

  const store = await openBioStore(workspace);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  try {
    const existing = await readReleaseFromLedger(store.conn, lake.lakeId, releaseId);
    if (existing) {
      if (existing.releaseDigest !== releaseDigest) {
        throw new ClinVarTemporalInputError(`ClinVar release '${releaseId}' already exists with different immutable content`);
      }
      return existing;
    }

    const raw = await putCas(cas, rawBytes, rawMediaType);
    const normalizedArtifact = await putCas(cas, normalizedBytes, NORMALIZED_MEDIA_TYPE);
    const duckLakeSnapshotId = await ingestDuckLakeRelease({
      lake,
      releaseId,
      releasedAt,
      sourceUri,
      sourceFormat,
      rawDigest,
      rawMediaType,
      normalizedDigest,
      parser,
      assertionCount: assertions.length,
      releaseDigest,
      registeredAt: recordedAt,
      assertions,
    });
    const result: ClinVarRelease = {
      schema: CLINVAR_RELEASE_SCHEMA,
      lakeId: lake.lakeId,
      releaseId,
      releasedAt,
      sourceUri,
      sourceFormat,
      rawDigest,
      rawUri: raw.uri,
      rawMediaType,
      normalizedDigest,
      normalizedUri: normalizedArtifact.uri,
      parser,
      assertionCount: assertions.length,
      duckLakeSnapshotId,
      duckLakeConfigDigest: lakeConfigDigest,
      releaseDigest,
      recordedAt,
    };
    await inTransaction(store.conn, async () => {
      const concurrent = await readReleaseFromLedger(store.conn, lake.lakeId, releaseId);
      if (concurrent) {
        if (concurrent.releaseDigest !== releaseDigest) {
          throw new ClinVarTemporalInputError(`ClinVar release '${releaseId}' already exists with different immutable content`);
        }
        return;
      }
      const node = releaseNode(lake.lakeId, releaseId);
      const value: ReleaseLedgerValue = {
        schema: CLINVAR_RELEASE_SCHEMA,
        lake_id: lake.lakeId,
        release_id: releaseId,
        released_at: releasedAt,
        source_uri: sourceUri,
        source_format: sourceFormat,
        raw_digest: rawDigest,
        raw_uri: raw.uri,
        raw_media_type: rawMediaType,
        normalized_digest: normalizedDigest,
        normalized_uri: normalizedArtifact.uri,
        parser_id: parser.id,
        parser_version: parser.version,
        parser_digest: parser.implementationDigest,
        assertion_count: assertions.length,
        ducklake_snapshot_id: duckLakeSnapshotId,
        ducklake_config_digest: lakeConfigDigest,
        release_digest: releaseDigest,
      };
      await recordObservation(store.conn, {
        statementKey: releaseStatementKey(lake.lakeId, releaseId),
        subjectId: node,
        predicate: "clinvar_release",
        value,
        recordedAt,
        source: SOURCE,
        digest: releaseDigest,
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: rawDigest,
          mediaType: rawMediaType,
          semanticRole: "clinvar_source_release",
          sizeBytes: raw.sizeBytes,
          attrs: { lake_id: lake.lakeId, release_id: releaseId, source_uri: sourceUri, source_format: sourceFormat },
        },
        subjectId: node,
        predicate: "uses_source",
        recordedAt,
        source: SOURCE,
        digest: releaseDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "clinvar_source_release" },
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: normalizedDigest,
          mediaType: NORMALIZED_MEDIA_TYPE,
          semanticRole: "clinvar_normalized_release",
          sizeBytes: normalizedArtifact.sizeBytes,
          attrs: { lake_id: lake.lakeId, release_id: releaseId, parser_digest: parser.implementationDigest },
        },
        subjectId: node,
        predicate: "produces",
        recordedAt,
        source: SOURCE,
        digest: releaseDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "clinvar_normalized_release" },
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "materialized_at",
        objectId: `ducklake-snapshot:${lake.lakeId}:${duckLakeSnapshotId}`,
        recordedAt,
        source: SOURCE,
        digest: releaseDigest,
        attrs: { lake_id: lake.lakeId, snapshot_id: duckLakeSnapshotId },
      });
    });
    return result;
  } finally {
    store.close();
  }
}

export async function getClinVarRelease(
  workspace: string,
  lake: ClinVarDuckLakeConfig,
  releaseId: string,
  asOf = AS_OF,
): Promise<ClinVarRelease | null> {
  const normalizedLake = normalizeLake(lake);
  const normalizedReleaseId = assertReleaseId(releaseId);
  const store = await openBioStore(workspace);
  try {
    const release = await readReleaseFromLedger(store.conn, normalizedLake.lakeId, normalizedReleaseId, asOf);
    if (release && release.duckLakeConfigDigest !== duckLakeConfigDigest(normalizedLake)) {
      throw new ClinVarTemporalInputError(`ClinVar release '${normalizedReleaseId}' belongs to a different DuckLake host configuration`);
    }
    return release;
  } finally {
    store.close();
  }
}

export async function listClinVarReleases(
  workspace: string,
  lake: ClinVarDuckLakeConfig,
  options: { limit?: number; asOf?: string } = {},
): Promise<ClinVarReleaseSummary[]> {
  const normalizedLake = normalizeLake(lake);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new ClinVarTemporalInputError("limit must be an integer from 1 through 1000");
  const asOf = options.asOf ?? AS_OF;
  const store = await openBioStore(workspace);
  try {
    const rows = await store.conn.all<{ value_json: string; recorded_at: string }>(
      `WITH eligible AS (
         SELECT * FROM bio_observations
         WHERE predicate = 'clinvar_release'
           AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
           AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
           AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
       ), current AS (
         SELECT *, row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
         FROM eligible
       )
       SELECT value_json, recorded_at FROM current
       WHERE rn = 1
         AND json_extract_string(value_json, '$.lake_id') = ?
         AND json_extract_string(value_json, '$.ducklake_config_digest') = ?
       ORDER BY recorded_at::TIMESTAMPTZ DESC, statement_key DESC
       LIMIT ?`,
      [asOf, asOf, asOf, normalizedLake.lakeId, duckLakeConfigDigest(normalizedLake), limit],
    );
    return rows.map((row) => {
      const value = parseLedgerValue(row.value_json);
      const release = releaseFromValue(value, row.recorded_at);
      return {
        lakeId: release.lakeId,
        releaseId: release.releaseId,
        releasedAt: release.releasedAt,
        sourceUri: release.sourceUri,
        sourceFormat: release.sourceFormat,
        rawDigest: release.rawDigest,
        normalizedDigest: release.normalizedDigest,
        assertionCount: release.assertionCount,
        duckLakeSnapshotId: release.duckLakeSnapshotId,
        duckLakeConfigDigest: release.duckLakeConfigDigest,
        releaseDigest: release.releaseDigest,
        recordedAt: release.recordedAt,
      } satisfies ClinVarReleaseSummary;
    });
  } finally {
    store.close();
  }
}

/** Host bootstrap for a read-only, exact-snapshot analysis connection. The raw path stays out of replay JSON. */
export function clinVarDuckLakeInitSql(lake: ClinVarDuckLakeConfig, snapshotVersion: number): string[] {
  const normalizedLake = normalizeLake(lake);
  if (!Number.isInteger(snapshotVersion) || snapshotVersion < 0) throw new ClinVarTemporalInputError("snapshotVersion must be a non-negative integer");
  return [
    "LOAD ducklake",
    `ATTACH ${sqlString(`ducklake:${normalizedLake.catalogPath}`)} AS ${CATALOG_ALIAS} (READ_ONLY, SNAPSHOT_VERSION ${snapshotVersion})`,
  ];
}

function graphSource(release: ClinVarRelease): string {
  return `ducklake:${release.lakeId}@config:${release.duckLakeConfigDigest}@snapshot:${release.duckLakeSnapshotId}`;
}

/**
 * A derived, bounded SQL graph view for one source release. These rows are intentionally not copied wholesale into
 * `bio_observations`; release provenance is ledger state, while millions of ClinVar relationships stay queryable in DuckLake.
 */
export function buildClinVarAssertionGraphManifest(release: ClinVarRelease): BioManifest {
  const source = graphSource(release);
  return {
    schema: "pi-bio.manifest.v1",
    id: `clinvar-temporal-${release.lakeId}`,
    version: "0.1.0",
    title: "Release-pinned ClinVar assertion graph",
    description: "Project one normalized ClinVar release into edge-shaped SQL rows at an exact DuckLake snapshot.",
    provides: {
      resolvers: [{
        id: "duckdb.sql_materialize",
        version: "0.1.0",
        title: "DuckDB SQL materialization",
        description: "Materialize declared read-only SQL from a host-attached DuckLake snapshot.",
        output: { mode: "table" },
        temporal: { kind: "snapshot", source, versionRequired: true },
      }],
      resources: [{
        id: "clinvar_assertion_edges",
        title: "ClinVar assertion graph edges",
        kind: "virtual",
        resolver: "duckdb.sql_materialize",
        params: {
          table: "clinvar_assertion_edges",
          extensions: ["ducklake"],
          declaredSources: [source, release.sourceUri],
          sql: `WITH assertions AS (
  SELECT * FROM ${CATALOG_ALIAS}.clinvar_assertions
  WHERE release_id = getvariable('clinvar_release_id')
), variation_edges AS (
  SELECT
    'clinvar-assertion:' || release_id || ':' || assertion_id AS from_id,
    'clinvar:about_variation' AS predicate,
    'clinvar-variation:' || variation_id AS to_id,
    release_id,
    assertion_id,
    temporal_key,
    record_scope,
    clinical_significance,
    review_status
  FROM assertions
), condition_edges AS (
  SELECT
    'clinvar-assertion:' || release_id || ':' || assertion_id AS from_id,
    'clinvar:about_condition' AS predicate,
    'clinvar-condition:' || condition_id AS to_id,
    release_id,
    assertion_id,
    temporal_key,
    record_scope,
    clinical_significance,
    review_status
  FROM assertions
  WHERE condition_id IS NOT NULL AND condition_id <> ''
), gene_edges AS (
  SELECT
    'clinvar-assertion:' || a.release_id || ':' || a.assertion_id AS from_id,
    'clinvar:mentions_gene' AS predicate,
    'gene:' || json_extract_string(gene.value, '$') AS to_id,
    a.release_id,
    a.assertion_id,
    a.temporal_key,
    a.record_scope,
    a.clinical_significance,
    a.review_status
  FROM assertions a
  CROSS JOIN json_each(CAST(a.gene_ids_json AS JSON)) AS gene
)
SELECT * FROM variation_edges
UNION ALL SELECT * FROM condition_edges
UNION ALL SELECT * FROM gene_edges`,
        },
      }],
      operations: [{
        id: "clinical.clinvar_assertion_graph",
        version: "0.1.0",
        title: "Project release-pinned ClinVar assertion edges",
        description: "Return graph-shaped assertion, variation, condition, and gene rows without treating classifications as diagnoses.",
        transport: "duckdb.sql",
        inputSchema: {
          type: "object",
          properties: { clinvar_release_id: { type: "string" } },
          required: ["clinvar_release_id"],
        },
        notes: [
          "The host attaches the declared DuckLake snapshot read-only.",
          "The graph is a SQL projection over normalized source rows, not a second graph database or a copy of ClinVar in the observation ledger.",
        ],
        sql: {
          readOnly: true,
          requiredResources: ["clinvar_assertion_edges"],
          sqlTemplate: "SELECT * FROM clinvar_assertion_edges ORDER BY from_id, predicate, to_id",
        },
      }],
    },
  };
}

/**
 * Baseline-only candidate selection for a prepared temporal task. The policy is source-label routing, not a clinical
 * classification rule, and it is applied in SQL over the agent's exact baseline snapshot.
 */
export function buildClinVarTemporalCandidateManifest(release: ClinVarRelease): BioManifest {
  const source = graphSource(release);
  return {
    schema: "pi-bio.manifest.v1",
    id: `clinvar-temporal-candidates-${release.lakeId}`,
    version: "0.1.0",
    title: "Baseline-pinned ClinVar temporal candidates",
    description: "Select source-label candidates from one release-pinned ClinVar snapshot without target-release access.",
    provides: {
      resolvers: [{
        id: "duckdb.sql_materialize",
        version: "0.1.0",
        title: "DuckDB SQL materialization",
        description: "Materialize declared baseline-only candidates from a host-attached DuckLake snapshot.",
        output: { mode: "table" },
        temporal: { kind: "snapshot", source, versionRequired: true },
      }],
      resources: [{
        id: "clinvar_temporal_candidates",
        title: "Baseline ClinVar temporal candidates",
        kind: "virtual",
        resolver: "duckdb.sql_materialize",
        params: {
          table: "clinvar_temporal_candidates",
          extensions: ["ducklake"],
          declaredSources: [source, release.sourceUri],
          sql: `WITH policy AS (
  SELECT
    from_json(CAST(getvariable('clinvar_candidate_significances_json') AS JSON), '["VARCHAR"]') AS significances,
    from_json(CAST(getvariable('clinvar_candidate_review_statuses_json') AS JSON), '["VARCHAR"]') AS review_statuses
)
SELECT
  a.release_id,
  a.assertion_id,
  a.temporal_key,
  a.record_scope,
  a.variation_id,
  a.condition_id,
  a.condition_label,
  a.gene_ids_json,
  a.clinical_significance,
  a.review_status,
  a.submitter,
  a.last_evaluated,
  a.attributes_json
FROM ${CATALOG_ALIAS}.clinvar_assertions a
CROSS JOIN policy p
WHERE a.release_id = getvariable('clinvar_release_id')
  AND list_contains(p.significances, a.clinical_significance)
  AND (
    json_array_length(CAST(getvariable('clinvar_candidate_review_statuses_json') AS JSON)) = 0
    OR list_contains(p.review_statuses, a.review_status)
  )`,
        },
      }],
      operations: [{
        id: "clinical.clinvar_temporal_candidates",
        version: "0.1.0",
        title: "Select baseline-pinned ClinVar candidates",
        description: "Return policy-selected source assertions from the baseline only; it is not a diagnosis or future-label query.",
        transport: "duckdb.sql",
        inputSchema: {
          type: "object",
          properties: {
            clinvar_release_id: { type: "string" },
            clinvar_candidate_significances_json: { type: "string" },
            clinvar_candidate_review_statuses_json: { type: "string" },
          },
          required: [
            "clinvar_release_id",
            "clinvar_candidate_significances_json",
            "clinvar_candidate_review_statuses_json",
          ],
        },
        notes: [
          "Candidate selection is a declared baseline source-label filter so an agent need not infer or serialize a large catalog.",
          "The target release is neither attached nor named by this operation.",
        ],
        sql: {
          readOnly: true,
          requiredResources: ["clinvar_temporal_candidates"],
          sqlTemplate: "SELECT * FROM clinvar_temporal_candidates ORDER BY temporal_key, assertion_id",
        },
      }],
    },
  };
}

/** Return the full comparison relation. The evaluator decides what subset and metric make a valid benchmark. */
export function buildClinVarClassificationDeltaManifest(baseline: ClinVarRelease, target: ClinVarRelease): BioManifest {
  if (baseline.lakeId !== target.lakeId) throw new ClinVarTemporalInputError("baseline and target releases must belong to one DuckLake");
  const source = graphSource(target);
  return {
    schema: "pi-bio.manifest.v1",
    id: `clinvar-temporal-delta-${baseline.lakeId}`,
    version: "0.1.0",
    title: "Release-pinned ClinVar classification delta",
    description: "Compare source-supplied temporal identities between two immutable ClinVar releases.",
    provides: {
      resolvers: [{
        id: "duckdb.sql_materialize",
        version: "0.1.0",
        title: "DuckDB SQL materialization",
        description: "Materialize a declared temporal comparison from a host-attached DuckLake snapshot.",
        output: { mode: "table" },
        temporal: { kind: "snapshot", source, versionRequired: true },
      }],
      resources: [{
        id: "clinvar_classification_delta",
        title: "ClinVar classification delta",
        kind: "virtual",
        resolver: "duckdb.sql_materialize",
        params: {
          table: "clinvar_classification_delta",
          extensions: ["ducklake"],
          declaredSources: [source, baseline.sourceUri, target.sourceUri],
          sql: `WITH baseline AS (
  SELECT temporal_key, assertion_id, record_scope, variation_id, condition_id, clinical_significance, review_status
  FROM ${CATALOG_ALIAS}.clinvar_assertions
  WHERE release_id = getvariable('clinvar_baseline_release_id')
), target AS (
  SELECT temporal_key, assertion_id, record_scope, variation_id, condition_id, clinical_significance, review_status
  FROM ${CATALOG_ALIAS}.clinvar_assertions
  WHERE release_id = getvariable('clinvar_target_release_id')
)
SELECT
  coalesce(b.temporal_key, t.temporal_key) AS temporal_key,
  b.assertion_id AS baseline_assertion_id,
  t.assertion_id AS target_assertion_id,
  coalesce(b.record_scope, t.record_scope) AS record_scope,
  coalesce(b.variation_id, t.variation_id) AS variation_id,
  coalesce(b.condition_id, t.condition_id) AS condition_id,
  b.clinical_significance AS baseline_clinical_significance,
  t.clinical_significance AS target_clinical_significance,
  b.review_status AS baseline_review_status,
  t.review_status AS target_review_status,
  CASE
    WHEN b.temporal_key IS NULL THEN 'introduced'
    WHEN t.temporal_key IS NULL THEN 'removed'
    WHEN b.clinical_significance IS NOT DISTINCT FROM t.clinical_significance
      AND b.review_status IS NOT DISTINCT FROM t.review_status THEN 'unchanged'
    WHEN b.clinical_significance IS NOT DISTINCT FROM t.clinical_significance THEN 'review_status_changed'
    ELSE 'classification_changed'
  END AS change_kind
FROM baseline b
FULL OUTER JOIN target t USING (temporal_key)`,
        },
      }],
      operations: [{
        id: "clinical.clinvar_classification_delta",
        version: "0.1.0",
        title: "Compare release-pinned ClinVar classifications",
        description: "Return source-label changes for a retrospective evaluation; this is not a clinical truth or diagnostic decision.",
        transport: "duckdb.sql",
        inputSchema: {
          type: "object",
          properties: {
            clinvar_baseline_release_id: { type: "string" },
            clinvar_target_release_id: { type: "string" },
          },
          required: ["clinvar_baseline_release_id", "clinvar_target_release_id"],
        },
        notes: [
          "Temporal joins use the normalizer-declared temporal_key; no VCV/RCV/SCV identity is guessed by the workbench.",
          "The target release is attached at its exact DuckLake snapshot so later catalog updates are not visible to this run.",
        ],
        sql: {
          readOnly: true,
          requiredResources: ["clinvar_classification_delta"],
          sqlTemplate: "SELECT * FROM clinvar_classification_delta ORDER BY temporal_key",
        },
      }],
    },
  };
}

async function assertRegisteredRelease(workspace: string, lake: ClinVarDuckLakeConfig, release: ClinVarRelease): Promise<void> {
  const stored = await getClinVarRelease(workspace, lake, release.releaseId);
  if (
    !stored
    || stored.releaseDigest !== release.releaseDigest
    || stored.duckLakeSnapshotId !== release.duckLakeSnapshotId
    || stored.duckLakeConfigDigest !== release.duckLakeConfigDigest
  ) {
    throw new ClinVarTemporalInputError(`ClinVar release '${release.releaseId}' is not the registered immutable release for this workspace`);
  }
}

async function runRecordedOperation(args: {
  workspace: string;
  lake: ClinVarDuckLakeConfig;
  snapshotVersion: number;
  manifest: BioManifest;
  operationId: string;
  bindings: Record<string, unknown>;
  runId?: string;
  now?: string;
  dbPath?: string;
  hostCapabilityReceipts?: readonly HostCapabilityReceipt[];
}): Promise<RecordedClinVarOperation> {
  const store = await openBioStore(args.workspace);
  const cas = fsCasStore(join(args.workspace, ".pi", "bio-agent", "cas"));
  try {
    const response = await runBioOperationFromManifest({
      cwd: args.workspace,
      dbPath: args.dbPath ?? ":memory:",
      manifestSnapshot: args.manifest,
      manifestBaseDir: args.workspace,
      operationId: args.operationId,
      bindings: args.bindings,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(args.now ? { now: args.now } : {}),
      duckdbInitSql: clinVarDuckLakeInitSql(args.lake, args.snapshotVersion),
      ...(args.hostCapabilityReceipts ? { hostCapabilityReceipts: args.hostCapabilityReceipts } : {}),
      store: store.conn,
      author: SOURCE,
      cas,
      casMetadata: { conn: store.conn },
      serialize: false,
    });
    if (!response.ok) throw new Error(`ClinVar operation '${args.operationId}' failed: ${response.error}`);
    if (!response.casRefs?.result || !response.casRefs.receipts || !response.casRefs.replay || !response.casRefs.runObject) {
      throw new Error(`ClinVar operation '${args.operationId}' completed without complete CAS evidence`);
    }
    return {
      runId: response.runId,
      rows: response.result.rows as Array<Record<string, unknown>>,
      casRefs: response.casRefs,
    };
  } finally {
    store.close();
  }
}

/** Execute a release-pinned graph projection through the normal manifest/SQL/run/CAS/ledger path. */
export async function runClinVarAssertionGraph(
  workspace: string,
  lake: ClinVarDuckLakeConfig,
  release: ClinVarRelease,
  options: { runId?: string; now?: string; dbPath?: string; hostCapabilityReceipts?: readonly HostCapabilityReceipt[] } = {},
): Promise<RecordedClinVarOperation> {
  const normalizedLake = normalizeLake(lake);
  if (release.lakeId !== normalizedLake.lakeId) throw new ClinVarTemporalInputError("release lakeId does not match the supplied DuckLake configuration");
  await assertRegisteredRelease(workspace, normalizedLake, release);
  return runRecordedOperation({
    workspace,
    lake: normalizedLake,
    snapshotVersion: release.duckLakeSnapshotId,
    manifest: buildClinVarAssertionGraphManifest(release),
    operationId: "clinical.clinvar_assertion_graph",
    bindings: { clinvar_release_id: release.releaseId },
    ...options,
  });
}

/**
 * Execute the safe task's candidate selection. Its isolation receipt is not caller-optional: the source-pinned run
 * records the host policy that made the baseline-only access boundary meaningful.
 */
export async function runClinVarTemporalCandidates(
  agentWorkspace: string,
  agentLake: ClinVarDuckLakeConfig,
  taskId: string,
  options: { runId?: string; now?: string; dbPath?: string } = {},
): Promise<RecordedClinVarOperation> {
  const task = await getClinVarTemporalTask(agentWorkspace, taskId);
  if (!task) throw new ClinVarTemporalInputError(`ClinVar temporal task '${taskId}' does not exist`);
  const lake = normalizeLake(agentLake);
  if (
    task.agentRelease.lakeId !== lake.lakeId
    || task.agentRelease.duckLakeConfigDigest !== duckLakeConfigDigest(lake)
    || !releaseFromBaseline(task.agentRelease, task.task.agentBaseline)
  ) {
    throw new ClinVarTemporalInputError(`ClinVar temporal task '${taskId}' does not match the supplied agent DuckLake`);
  }
  return runRecordedOperation({
    workspace: resolve(assertText("agentWorkspace", agentWorkspace)),
    lake,
    snapshotVersion: task.agentRelease.duckLakeSnapshotId,
    manifest: buildClinVarTemporalCandidateManifest(task.agentRelease),
    operationId: "clinical.clinvar_temporal_candidates",
    bindings: {
      clinvar_release_id: task.agentRelease.releaseId,
      clinvar_candidate_significances_json: JSON.stringify(task.task.candidatePolicy.baselineClinicalSignificances),
      clinvar_candidate_review_statuses_json: JSON.stringify(task.task.candidatePolicy.baselineReviewStatuses ?? []),
    },
    ...options,
    hostCapabilityReceipts: [task.task.isolation],
  });
}

/**
 * Execute the evaluator-side delta at the target release snapshot. Releases must be imported chronologically so
 * the target snapshot contains the baseline; otherwise the function fails instead of querying mutable latest state.
 */
export async function runClinVarClassificationDelta(
  workspace: string,
  lake: ClinVarDuckLakeConfig,
  baseline: ClinVarRelease,
  target: ClinVarRelease,
  options: { runId?: string; now?: string; dbPath?: string; hostCapabilityReceipts?: readonly HostCapabilityReceipt[] } = {},
): Promise<RecordedClinVarOperation> {
  const normalizedLake = normalizeLake(lake);
  if (baseline.lakeId !== normalizedLake.lakeId || target.lakeId !== normalizedLake.lakeId) {
    throw new ClinVarTemporalInputError("baseline and target must match the supplied DuckLake configuration");
  }
  assertReleaseOrder(baseline, target);
  await assertRegisteredRelease(workspace, normalizedLake, baseline);
  await assertRegisteredRelease(workspace, normalizedLake, target);
  return runRecordedOperation({
    workspace,
    lake: normalizedLake,
    snapshotVersion: target.duckLakeSnapshotId,
    manifest: buildClinVarClassificationDeltaManifest(baseline, target),
    operationId: "clinical.clinvar_classification_delta",
    bindings: {
      clinvar_baseline_release_id: baseline.releaseId,
      clinvar_target_release_id: target.releaseId,
    },
    ...options,
  });
}

function taskArtifact(task: ClinVarTemporalTask): {
  bytes: Buffer;
  digest: `sha256:${string}`;
  uri: `cas:sha256:${string}`;
} {
  const bytes = canonicalJsonBytes(task as unknown as JsonValue);
  const digest = sha256(bytes);
  return { bytes, digest, uri: `cas:${digest}` };
}

async function recordTemporalTask(args: {
  workspace: string;
  task: ClinVarTemporalTask;
  recordedAt: string;
}): Promise<{ task: ClinVarTemporalTask; taskArtifactDigest: `sha256:${string}`; taskArtifactUri: `cas:sha256:${string}` }> {
  const cas = fsCasStore(join(args.workspace, ".pi", "bio-agent", "cas"));
  const artifact = taskArtifact(args.task);
  await cas.put({ ...casAddress(artifact.digest), sizeBytes: artifact.bytes.length, mediaType: TEMPORAL_TASK_MEDIA_TYPE }, artifact.bytes);
  const store = await openBioStore(args.workspace);
  try {
    return await inTransaction(store.conn, async () => {
      const existing = await readTemporalTaskFromLedger(store.conn, cas, args.task.taskId);
      if (existing) {
        if (existing.task.taskDigest !== args.task.taskDigest) {
          throw new ClinVarTemporalInputError(`ClinVar temporal task '${args.task.taskId}' already exists with different immutable content`);
        }
        return existing;
      }
      const node = temporalTaskNode(args.task.taskId);
      const value: TemporalTaskLedgerValue = {
        schema: CLINVAR_TEMPORAL_TASK_SCHEMA,
        task_id: args.task.taskId,
        task_digest: args.task.taskDigest,
        task_artifact_digest: artifact.digest,
        task_artifact_uri: artifact.uri,
        agent_lake_id: args.task.agentBaseline.lakeId,
        agent_release_id: args.task.agentBaseline.releaseId,
        agent_release_digest: args.task.agentBaseline.releaseDigest,
        agent_lake_config_digest: args.task.agentBaseline.duckLakeConfigDigest,
        target_commitment: args.task.targetCommitment,
        isolation_policy_digest: args.task.isolation.policyDigest,
      };
      await recordObservation(store.conn, {
        statementKey: temporalTaskStatementKey(args.task.taskId),
        subjectId: node,
        predicate: "clinvar_temporal_task",
        value,
        recordedAt: args.recordedAt,
        source: SOURCE,
        digest: args.task.taskDigest,
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: artifact.digest,
          mediaType: TEMPORAL_TASK_MEDIA_TYPE,
          semanticRole: "clinvar_temporal_task",
          sizeBytes: artifact.bytes.length,
          attrs: { task_id: args.task.taskId, baseline_release_digest: args.task.agentBaseline.releaseDigest },
        },
        subjectId: node,
        predicate: "produces",
        recordedAt: args.recordedAt,
        source: SOURCE,
        digest: args.task.taskDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "clinvar_temporal_task" },
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "uses_baseline_release",
        objectId: releaseNode(args.task.agentBaseline.lakeId, args.task.agentBaseline.releaseId),
        recordedAt: args.recordedAt,
        source: SOURCE,
        digest: args.task.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "commits_to",
        objectId: `clinvar-target-commitment:${args.task.targetCommitment}`,
        recordedAt: args.recordedAt,
        source: SOURCE,
        digest: args.task.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "runs_under_host_policy",
        objectId: `host-capability:${args.task.isolation.policyDigest}`,
        recordedAt: args.recordedAt,
        source: SOURCE,
        digest: args.task.taskDigest,
        attrs: { receipt_schema: args.task.isolation.schema, target_access: args.task.isolation.targetAccess },
      });
      return { task: args.task, taskArtifactDigest: artifact.digest, taskArtifactUri: artifact.uri };
    });
  } finally {
    store.close();
  }
}

function evaluationValue(
  evaluation: ClinVarTemporalEvaluation,
  commitmentSecret: { digest: `sha256:${string}`; uri: `cas:sha256:${string}` },
): TemporalEvaluationLedgerValue {
  return {
    schema: CLINVAR_TEMPORAL_EVALUATION_SCHEMA,
    task_id: evaluation.taskId,
    task_digest: evaluation.taskDigest,
    evaluator_baseline_lake_id: evaluation.evaluatorBaseline.lakeId,
    evaluator_baseline_release_id: evaluation.evaluatorBaseline.releaseId,
    evaluator_baseline_release_digest: evaluation.evaluatorBaseline.releaseDigest,
    evaluator_baseline_lake_config_digest: evaluation.evaluatorBaseline.duckLakeConfigDigest,
    target_lake_id: evaluation.target.lakeId,
    target_release_id: evaluation.target.releaseId,
    target_release_digest: evaluation.target.releaseDigest,
    target_lake_config_digest: evaluation.target.duckLakeConfigDigest,
    target_commitment: evaluation.targetCommitment,
    target_commitment_secret_digest: commitmentSecret.digest,
    target_commitment_secret_uri: commitmentSecret.uri,
    isolation_schema: evaluation.isolation.schema,
    isolation_mode: evaluation.isolation.mode,
    agent_boundary_id: evaluation.isolation.agentBoundaryId,
    evaluator_boundary_id: evaluation.isolation.evaluatorBoundaryId,
    target_access: evaluation.isolation.targetAccess,
    isolation_policy_digest: evaluation.isolation.policyDigest,
  };
}

async function recordTemporalEvaluation(
  workspace: string,
  evaluation: ClinVarTemporalEvaluation,
  targetCommitmentSecret: Buffer | Uint8Array,
): Promise<ClinVarTemporalEvaluation> {
  const secret = normalizeCommitmentSecret(targetCommitmentSecret);
  if (targetCommitment(evaluation.target, secret) !== evaluation.targetCommitment) {
    throw new ClinVarTemporalInputError("temporal evaluation target commitment does not match its evaluator-only secret");
  }
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const commitmentSecret = await putCas(cas, secret, TEMPORAL_COMMITMENT_SECRET_MEDIA_TYPE);
  const store = await openBioStore(workspace);
  try {
    return await inTransaction(store.conn, async () => {
      const existing = await readTemporalEvaluationFromLedger(store.conn, evaluation.taskId);
      const value = evaluationValue(evaluation, commitmentSecret);
      if (existing) {
        if (canonicalDigest(existing.value) !== canonicalDigest(value)) {
          throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${evaluation.taskId}' already exists with different immutable content`);
        }
        return { ...evaluation, recordedAt: existing.recordedAt };
      }
      const node = temporalEvaluationNode(evaluation.taskId);
      await recordObservation(store.conn, {
        statementKey: temporalEvaluationStatementKey(evaluation.taskId),
        subjectId: node,
        predicate: "clinvar_temporal_evaluation",
        value,
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "evaluates_task",
        objectId: temporalTaskNode(evaluation.taskId),
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "uses_baseline_release",
        objectId: releaseNode(evaluation.evaluatorBaseline.lakeId, evaluation.evaluatorBaseline.releaseId),
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "uses_target_release",
        objectId: releaseNode(evaluation.target.lakeId, evaluation.target.releaseId),
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "runs_under_host_policy",
        objectId: `host-capability:${evaluation.isolation.policyDigest}`,
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
        attrs: { receipt_schema: evaluation.isolation.schema, target_access: evaluation.isolation.targetAccess },
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: commitmentSecret.digest,
          mediaType: TEMPORAL_COMMITMENT_SECRET_MEDIA_TYPE,
          semanticRole: "clinvar_temporal_commitment_secret",
          sizeBytes: commitmentSecret.sizeBytes,
          attrs: { task_id: evaluation.taskId, evaluator_only: true },
        },
        subjectId: node,
        predicate: "uses_secret",
        recordedAt: evaluation.recordedAt,
        source: SOURCE,
        digest: evaluation.taskDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "clinvar_temporal_evaluation" },
      });
      return evaluation;
    });
  } finally {
    store.close();
  }
}

/**
 * Materialize a baseline-only agent task from an evaluator catalog. The target is never copied into the agent CAS,
 * ledger, or DuckLake catalog; only an opaque commitment reaches the task. A host must enforce the separate
 * workspaces/boundaries described by the supplied receipt before it gives the task to an agent.
 */
export async function prepareClinVarTemporalTask(request: PrepareClinVarTemporalTaskRequest): Promise<PreparedClinVarTemporalTask> {
  const evaluatorWorkspace = resolve(assertText("evaluatorWorkspace", request.evaluatorWorkspace));
  const agentWorkspace = resolve(assertText("agentWorkspace", request.agentWorkspace));
  const evaluatorLake = normalizeLake(request.evaluatorLake);
  const agentLake = normalizeLake(request.agentLake ?? defaultClinVarDuckLakeConfig(agentWorkspace));
  const targetCommitmentSecret = normalizeCommitmentSecret(request.targetCommitmentSecret);
  const isolation = validateClinVarTemporalIsolationReceipt(request.isolationReceipt);
  assertSeparateTemporalBoundaries(evaluatorWorkspace, agentWorkspace, evaluatorLake, agentLake);
  if (request.baseline.lakeId !== evaluatorLake.lakeId || request.target.lakeId !== evaluatorLake.lakeId) {
    throw new ClinVarTemporalInputError("baseline and target releases must belong to the evaluator DuckLake configuration");
  }
  assertReleaseOrder(request.baseline, request.target);
  await assertRegisteredRelease(evaluatorWorkspace, evaluatorLake, request.baseline);
  await assertRegisteredRelease(evaluatorWorkspace, evaluatorLake, request.target);

  const evaluatorCas = fsCasStore(join(evaluatorWorkspace, ".pi", "bio-agent", "cas"));
  const [rawBytes, normalized] = await Promise.all([
    readVerifiedCasBytes(evaluatorCas, request.baseline.rawDigest, `baseline ClinVar source '${request.baseline.releaseId}'`),
    readNormalizedReleaseFromCas(evaluatorCas, request.baseline),
  ]);
  await assertAgentLakeIsBaselineOnly(agentLake, request.baseline, normalized);
  const agentRelease = await registerClinVarRelease(agentWorkspace, {
    lake: agentLake,
    releaseId: request.baseline.releaseId,
    releasedAt: request.baseline.releasedAt,
    rawSource: {
      uri: request.baseline.sourceUri,
      format: request.baseline.sourceFormat,
      mediaType: request.baseline.rawMediaType,
      bytes: rawBytes,
    },
    parser: normalized.parser,
    assertions: normalized.assertions,
    recordedAt: request.recordedAt,
  });
  const candidatePolicy = normalizedCandidatePolicy(request.candidatePolicy);
  const commitment = targetCommitment(request.target, targetCommitmentSecret);
  const defaultTaskId = `clinvar-${canonicalDigest({
    baseline: request.baseline.releaseDigest,
    target_commitment: commitment,
    candidate_policy: candidatePolicy,
    isolation_policy: isolation.policyDigest,
  }).slice("sha256:".length, "sha256:".length + 20)}`;
  const taskId = request.taskId ? assertTaskId(request.taskId) : assertTaskId(defaultTaskId);
  const taskDraft: Omit<ClinVarTemporalTask, "taskDigest"> = {
    schema: CLINVAR_TEMPORAL_TASK_SCHEMA,
    taskId,
    agentBaseline: releaseBaseline(agentRelease),
    candidatePolicy,
    targetCommitment: commitment,
    isolation,
  };
  const task: ClinVarTemporalTask = { ...taskDraft, taskDigest: temporalTaskDigest(taskDraft) };
  const recordedAt = assertTimestamp("recordedAt", request.recordedAt ?? new Date().toISOString());
  const persisted = await recordTemporalTask({ workspace: agentWorkspace, task, recordedAt });
  const evaluation = await recordTemporalEvaluation(
    evaluatorWorkspace,
    {
      schema: CLINVAR_TEMPORAL_EVALUATION_SCHEMA,
      taskId: persisted.task.taskId,
      taskDigest: persisted.task.taskDigest,
      evaluatorBaseline: releaseBaseline(request.baseline),
      target: releaseBaseline(request.target),
      targetCommitment: commitment,
      isolation,
      recordedAt,
    },
    targetCommitmentSecret,
  );
  if (evaluation.taskDigest !== persisted.task.taskDigest || evaluation.targetCommitment !== persisted.task.targetCommitment) {
    throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${taskId}' does not match its agent task`);
  }
  return { ...persisted, agentRelease };
}

/** Read the safe baseline-only task artifact from the agent workspace. */
export async function getClinVarTemporalTask(
  agentWorkspace: string,
  taskId: string,
  asOf = AS_OF,
): Promise<PreparedClinVarTemporalTask | null> {
  const normalizedTaskId = assertTaskId(taskId);
  const workspace = resolve(assertText("agentWorkspace", agentWorkspace));
  const store = await openBioStore(workspace);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  try {
    const persisted = await readTemporalTaskFromLedger(store.conn, cas, normalizedTaskId, asOf);
    if (!persisted) return null;
    const release = await readReleaseFromLedger(
      store.conn,
      persisted.task.agentBaseline.lakeId,
      persisted.task.agentBaseline.releaseId,
      asOf,
    );
    if (!release || !releaseFromBaseline(release, persisted.task.agentBaseline)) {
      throw new ClinVarTemporalInputError(`ClinVar temporal task '${normalizedTaskId}' baseline release is unavailable or has drifted`);
    }
    return { ...persisted, agentRelease: release };
  } finally {
    store.close();
  }
}

/** Read the evaluator-only temporal comparison record. Do not expose this record to the acting agent. */
export async function getClinVarTemporalEvaluation(
  evaluatorWorkspace: string,
  evaluatorLake: ClinVarDuckLakeConfig,
  taskId: string,
  asOf = AS_OF,
): Promise<ClinVarTemporalEvaluation | null> {
  const workspace = resolve(assertText("evaluatorWorkspace", evaluatorWorkspace));
  const lake = normalizeLake(evaluatorLake);
  const normalizedTaskId = assertTaskId(taskId);
  const store = await openBioStore(workspace);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  try {
    const stored = await readTemporalEvaluationFromLedger(store.conn, normalizedTaskId, asOf);
    if (!stored) return null;
    const value = stored.value;
    const configDigest = duckLakeConfigDigest(lake);
    if (
      value.evaluator_baseline_lake_id !== lake.lakeId
      || value.target_lake_id !== lake.lakeId
      || value.evaluator_baseline_lake_config_digest !== configDigest
      || value.target_lake_config_digest !== configDigest
    ) {
      throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${normalizedTaskId}' does not belong to the supplied evaluator DuckLake`);
    }
    const [baseline, target] = await Promise.all([
      readReleaseFromLedger(store.conn, lake.lakeId, value.evaluator_baseline_release_id, asOf),
      readReleaseFromLedger(store.conn, lake.lakeId, value.target_release_id, asOf),
    ]);
    const secret = normalizeCommitmentSecret(await readVerifiedCasBytes(
      cas,
      value.target_commitment_secret_digest,
      `ClinVar temporal evaluation '${normalizedTaskId}' target commitment secret`,
    ));
    if (
      value.target_commitment_secret_uri !== `cas:${value.target_commitment_secret_digest}`
      || !baseline
      || !target
      || baseline.releaseDigest !== value.evaluator_baseline_release_digest
      || target.releaseDigest !== value.target_release_digest
      || baseline.duckLakeConfigDigest !== value.evaluator_baseline_lake_config_digest
      || target.duckLakeConfigDigest !== value.target_lake_config_digest
      || targetCommitment(target, secret) !== value.target_commitment
    ) {
      throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${normalizedTaskId}' release metadata has drifted`);
    }
    assertReleaseOrder(baseline, target);
    const isolation = validateClinVarTemporalIsolationReceipt({
      schema: value.isolation_schema,
      mode: value.isolation_mode,
      agentBoundaryId: value.agent_boundary_id,
      evaluatorBoundaryId: value.evaluator_boundary_id,
      targetAccess: value.target_access,
      policyDigest: value.isolation_policy_digest,
    });
    return {
      schema: CLINVAR_TEMPORAL_EVALUATION_SCHEMA,
      taskId: value.task_id,
      taskDigest: value.task_digest,
      evaluatorBaseline: releaseBaseline(baseline),
      target: releaseBaseline(target),
      targetCommitment: value.target_commitment,
      isolation,
      recordedAt: stored.recordedAt,
    };
  } finally {
    store.close();
  }
}

/**
 * Run the evaluator-only release delta for a prepared task. The target snapshot and source labels are introduced
 * only in this evaluator workspace, and the host isolation receipt is pinned into the recorded operation replay.
 */
export async function runClinVarTemporalEvaluation(
  evaluatorWorkspace: string,
  evaluatorLake: ClinVarDuckLakeConfig,
  taskId: string,
  options: { runId?: string; now?: string; dbPath?: string } = {},
): Promise<RecordedClinVarOperation> {
  const evaluation = await getClinVarTemporalEvaluation(evaluatorWorkspace, evaluatorLake, taskId);
  if (!evaluation) throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${taskId}' does not exist`);
  const baseline = await getClinVarRelease(evaluatorWorkspace, evaluatorLake, evaluation.evaluatorBaseline.releaseId);
  const target = await getClinVarRelease(evaluatorWorkspace, evaluatorLake, evaluation.target.releaseId);
  if (!baseline || !target || !releaseFromBaseline(baseline, evaluation.evaluatorBaseline) || !releaseFromBaseline(target, evaluation.target)) {
    throw new ClinVarTemporalInputError(`ClinVar temporal evaluation '${taskId}' releases are no longer registered exactly`);
  }
  const result = await runClinVarClassificationDelta(evaluatorWorkspace, evaluatorLake, baseline, target, {
    ...options,
    hostCapabilityReceipts: [evaluation.isolation],
  });
  const store = await openBioStore(evaluatorWorkspace);
  try {
    const recordedAt = assertTimestamp("now", options.now ?? new Date().toISOString());
    await recordObservationLink(store.conn, {
      subjectId: temporalEvaluationNode(evaluation.taskId),
      predicate: "produces_run",
      objectId: `run:${result.runId}`,
      recordedAt,
      source: SOURCE,
      digest: evaluation.taskDigest,
    });
  } finally {
    store.close();
  }
  return result;
}
