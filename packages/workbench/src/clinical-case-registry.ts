import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  canonicalDigest,
  fsCasStore,
  inTransaction,
  observationAsOfKey,
  openBioStore,
  recordArtifactReference,
  recordObservation,
  recordObservationLink,
  validateContentAddress,
  type CasStore,
  type ContentAddress,
  type JsonValue,
  type SqlConn,
} from "pi-bio-agent";

export const CLINICAL_CASE_REVISION_SCHEMA = "pi-bio.workbench.clinical_case_revision.v1" as const;

const SOURCE = "pi-bio-workbench:clinical-case-registry";
const CASE_REVISION_MEDIA_TYPE = "application/vnd.pi-bio.workbench.clinical-case-revision+json";
const AS_OF = "9999-12-31T23:59:59.999Z";
const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const RELATION_RE = /^[a-z][a-z0-9_]*$/;

export type ClinicalAffectedStatus = "affected" | "unaffected" | "unknown";
export type ClinicalSex = "female" | "male" | "unknown";

/** A family member is a pseudonymous case-local entity. Its sensitive descriptive content stays in the revision CAS object. */
export interface ClinicalCaseMemberInput {
  memberId: string;
  role?: string;
  affectedStatus?: ClinicalAffectedStatus;
  sex?: ClinicalSex;
  attributes?: Record<string, JsonValue>;
}

/** A directed family relation. `parent_of`, `sibling_of`, and `partner_of` are examples; the registry does not infer inheritance. */
export interface ClinicalCaseRelationshipInput {
  fromMemberId: string;
  predicate: string;
  toMemberId: string;
  sourceAssetId?: string;
  attributes?: Record<string, JsonValue>;
}

export interface ClinicalSampleMappingInput {
  memberId: string;
  sampleId: string;
}

interface ClinicalCaseAssetInputBase {
  assetId: string;
  kind: string;
  mediaType: string;
  format?: string;
  assembly?: string;
  memberIds?: readonly string[];
  sampleMappings?: readonly ClinicalSampleMappingInput[];
  attributes?: Record<string, JsonValue>;
}

/** In-memory input for small SDK-owned assets such as a narrative or pedigree. */
export interface ClinicalCaseAssetBytesInput extends ClinicalCaseAssetInputBase {
  bytes: Buffer | Uint8Array;
  digest?: never;
}

/** Reference to bytes already staged in this workspace's CAS, suitable for large VCF/BCF/table assets. */
export interface ClinicalCaseAssetReferenceInput extends ClinicalCaseAssetInputBase {
  digest: `sha256:${string}`;
  bytes?: never;
}

export type ClinicalCaseAssetInput = ClinicalCaseAssetBytesInput | ClinicalCaseAssetReferenceInput;

export interface ClinicalCaseAsset {
  assetId: string;
  kind: string;
  mediaType: string;
  digest: `sha256:${string}`;
  uri: `cas:sha256:${string}`;
  sizeBytes: number;
  format?: string;
  assembly?: string;
  memberIds: string[];
  sampleMappings: ClinicalSampleMappingInput[];
  attributes?: Record<string, JsonValue>;
}

export interface ClinicalCaseMember {
  memberId: string;
  role?: string;
  affectedStatus: ClinicalAffectedStatus;
  sex: ClinicalSex;
  attributes?: Record<string, JsonValue>;
}

export interface ClinicalCaseRelationship {
  fromMemberId: string;
  predicate: string;
  toMemberId: string;
  sourceAssetId?: string;
  attributes?: Record<string, JsonValue>;
}

/** Immutable clinical input state. It contains only CAS references for the raw assets. */
export interface ClinicalCaseRevision {
  schema: typeof CLINICAL_CASE_REVISION_SCHEMA;
  caseId: string;
  revisionId: string;
  parentRevisionId?: string;
  indexMemberIds: string[];
  members: ClinicalCaseMember[];
  relationships: ClinicalCaseRelationship[];
  assets: ClinicalCaseAsset[];
}

export interface RegisterClinicalCaseRevisionRequest {
  caseId: string;
  revisionId?: string;
  parentRevisionId?: string;
  indexMemberIds?: readonly string[];
  members: readonly ClinicalCaseMemberInput[];
  relationships?: readonly ClinicalCaseRelationshipInput[];
  assets: readonly ClinicalCaseAssetInput[];
  /** Event time for this registry action. It does not alter revision identity. */
  recordedAt?: string;
}

export interface ClinicalCaseRevisionSummary {
  caseId: string;
  revisionId: string;
  parentRevisionId: string | null;
  revisionDigest: `sha256:${string}`;
  revisionUri: `cas:sha256:${string}`;
  memberCount: number;
  assetCount: number;
  recordedAt: string;
}

export interface ClinicalCaseRevisionRecord {
  revision: ClinicalCaseRevision;
  summary: ClinicalCaseRevisionSummary;
}

export class ClinicalCaseRegistryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClinicalCaseRegistryInputError";
  }
}

type RevisionLedgerValue = {
  schema: typeof CLINICAL_CASE_REVISION_SCHEMA;
  case_id: string;
  revision_id: string;
  parent_revision_id: string | null;
  revision_digest: `sha256:${string}`;
  revision_uri: `cas:sha256:${string}`;
  member_count: number;
  asset_count: number;
};

function assertId(label: string, value: string | undefined): string {
  if (!value || !ID_RE.test(value)) {
    throw new ClinicalCaseRegistryInputError(`${label} must match ${ID_RE}`);
  }
  return value;
}

function assertRelation(value: string): string {
  if (!RELATION_RE.test(value)) {
    throw new ClinicalCaseRegistryInputError(`relationship predicate '${value}' must match ${RELATION_RE}`);
  }
  return value;
}

function assertMediaType(value: string): string {
  if (!value || !value.includes("/")) throw new ClinicalCaseRegistryInputError("asset mediaType must be a MIME type");
  return value;
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

function encodeJson(value: JsonValue): Buffer {
  return Buffer.from(JSON.stringify(canonicalJson(value)), "utf8");
}

function canonicalAttributes(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return canonicalJson(value) as Record<string, JsonValue>;
}

function contentAddress(digest: string): ContentAddress {
  const [algorithm, value, extra] = digest.split(":");
  const address = { algorithm: algorithm as ContentAddress["algorithm"], digest: value ?? "" };
  const errors = extra === undefined ? validateContentAddress(address) : ["digest contains extra fields"];
  if (errors.length) throw new Error(`invalid CAS digest '${digest}': ${errors.join("; ")}`);
  return address;
}

function revisionNode(caseId: string, revisionId: string): string {
  return `case-revision:${caseId}:${revisionId}`;
}

function memberNode(caseId: string, revisionId: string, memberId: string): string {
  return `case-member:${caseId}:${revisionId}:${memberId}`;
}

function assetNode(caseId: string, revisionId: string, assetId: string): string {
  return `case-asset:${caseId}:${revisionId}:${assetId}`;
}

function revisionStatementKey(caseId: string, revisionId: string): string {
  return `clinical-case-revision:${caseId}:${revisionId}`;
}

function normalizeMembers(input: readonly ClinicalCaseMemberInput[]): ClinicalCaseMember[] {
  if (input.length === 0) throw new ClinicalCaseRegistryInputError("a case revision requires at least one member");
  const seen = new Set<string>();
  const members = input.map((item) => {
    const memberId = assertId("memberId", item.memberId);
    if (seen.has(memberId)) throw new ClinicalCaseRegistryInputError(`duplicate memberId '${memberId}'`);
    seen.add(memberId);
    if (item.affectedStatus && !["affected", "unaffected", "unknown"].includes(item.affectedStatus)) {
      throw new ClinicalCaseRegistryInputError(`unsupported affectedStatus for '${memberId}'`);
    }
    if (item.sex && !["female", "male", "unknown"].includes(item.sex)) {
      throw new ClinicalCaseRegistryInputError(`unsupported sex for '${memberId}'`);
    }
    return {
      memberId,
      ...(item.role ? { role: item.role } : {}),
      affectedStatus: item.affectedStatus ?? "unknown",
      sex: item.sex ?? "unknown",
      ...(item.attributes ? { attributes: canonicalAttributes(item.attributes) } : {}),
    };
  });
  return members.sort((left, right) => left.memberId.localeCompare(right.memberId));
}

function normalizeRelationships(
  input: readonly ClinicalCaseRelationshipInput[],
  memberIds: ReadonlySet<string>,
  assetIds: ReadonlySet<string>,
): ClinicalCaseRelationship[] {
  const seen = new Set<string>();
  const relations = input.map((item) => {
    const fromMemberId = assertId("relationship.fromMemberId", item.fromMemberId);
    const toMemberId = assertId("relationship.toMemberId", item.toMemberId);
    if (!memberIds.has(fromMemberId) || !memberIds.has(toMemberId)) {
      throw new ClinicalCaseRegistryInputError(`relationship '${fromMemberId}:${item.predicate}:${toMemberId}' references an unknown member`);
    }
    const predicate = assertRelation(item.predicate);
    if (item.sourceAssetId && !assetIds.has(item.sourceAssetId)) {
      throw new ClinicalCaseRegistryInputError(`relationship sourceAssetId '${item.sourceAssetId}' is not an asset in this revision`);
    }
    const key = `${fromMemberId}\u0000${predicate}\u0000${toMemberId}\u0000${item.sourceAssetId ?? ""}`;
    if (seen.has(key)) throw new ClinicalCaseRegistryInputError(`duplicate relationship '${fromMemberId}:${predicate}:${toMemberId}'`);
    seen.add(key);
    return {
      fromMemberId,
      predicate,
      toMemberId,
      ...(item.sourceAssetId ? { sourceAssetId: item.sourceAssetId } : {}),
      ...(item.attributes ? { attributes: canonicalAttributes(item.attributes) } : {}),
    };
  });
  return relations.sort((left, right) => JSON.stringify(canonicalJson(left as unknown as JsonValue))
    .localeCompare(JSON.stringify(canonicalJson(right as unknown as JsonValue))));
}

async function writeAsset(cas: CasStore, input: ClinicalCaseAssetInput, memberIds: ReadonlySet<string>): Promise<ClinicalCaseAsset> {
  const assetId = assertId("assetId", input.assetId);
  const mediaType = assertMediaType(input.mediaType);
  let digest: string;
  let sizeBytes: number;
  if ("bytes" in input && input.bytes !== undefined) {
    const bytes = Buffer.from(input.bytes);
    if (bytes.length === 0) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' has no bytes`);
    digest = createHash("sha256").update(bytes).digest("hex");
    sizeBytes = bytes.length;
    await cas.put({ algorithm: "sha256", digest, sizeBytes, mediaType }, bytes);
  } else {
    const address = contentAddress(input.digest);
    const path = cas.pathFor(address);
    if (!await cas.has(address)) {
      throw new ClinicalCaseRegistryInputError(`asset '${assetId}' references CAS bytes that are not present`);
    }
    const hash = createHash("sha256");
    sizeBytes = 0;
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(bytes);
      sizeBytes += bytes.length;
    }
    digest = hash.digest("hex");
    if (digest !== address.digest.toLowerCase()) {
      throw new ClinicalCaseRegistryInputError(`asset '${assetId}' CAS bytes do not match digest '${input.digest}'`);
    }
    if (sizeBytes === 0) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' has no bytes`);
  }
  const assetMemberIds = [...new Set((input.memberIds ?? []).map((memberId) => assertId(`asset '${assetId}' memberId`, memberId)))].sort();
  for (const memberId of assetMemberIds) {
    if (!memberIds.has(memberId)) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' references unknown member '${memberId}'`);
  }
  const sampleMappings = (input.sampleMappings ?? []).map((mapping) => ({
    memberId: assertId(`asset '${assetId}' sample mapping memberId`, mapping.memberId),
    sampleId: mapping.sampleId.trim(),
  }));
  const samples = new Set<string>();
  for (const mapping of sampleMappings) {
    if (!mapping.sampleId) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' has an empty sampleId`);
    if (!memberIds.has(mapping.memberId)) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' maps unknown member '${mapping.memberId}'`);
    if (samples.has(mapping.sampleId)) throw new ClinicalCaseRegistryInputError(`asset '${assetId}' maps sample '${mapping.sampleId}' more than once`);
    samples.add(mapping.sampleId);
  }
  return {
    assetId,
    kind: input.kind.trim() || (() => { throw new ClinicalCaseRegistryInputError(`asset '${assetId}' kind is required`); })(),
    mediaType,
    digest: `sha256:${digest}`,
    uri: `cas:sha256:${digest}`,
    sizeBytes,
    ...(input.format ? { format: input.format } : {}),
    ...(input.assembly ? { assembly: input.assembly } : {}),
    memberIds: assetMemberIds,
    sampleMappings: sampleMappings.sort((left, right) => left.sampleId.localeCompare(right.sampleId)),
    ...(input.attributes ? { attributes: canonicalAttributes(input.attributes) } : {}),
  };
}

function asRevisionLedgerValue(valueJson: string): RevisionLedgerValue {
  const value = JSON.parse(valueJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("clinical case revision ledger value is not an object");
  const item = value as Record<string, unknown>;
  if (
    item.schema !== CLINICAL_CASE_REVISION_SCHEMA
    || typeof item.case_id !== "string"
    || typeof item.revision_id !== "string"
    || typeof item.revision_digest !== "string"
    || typeof item.revision_uri !== "string"
    || typeof item.member_count !== "number"
    || typeof item.asset_count !== "number"
  ) {
    throw new Error("clinical case revision ledger value has an invalid schema");
  }
  return item as RevisionLedgerValue;
}

async function readRevisionFromLedger(
  conn: SqlConn,
  cas: CasStore,
  caseId: string,
  revisionId: string,
  asOf = AS_OF,
): Promise<{ revision: ClinicalCaseRevision; summary: ClinicalCaseRevisionSummary } | null> {
  const observation = await observationAsOfKey(conn, revisionStatementKey(caseId, revisionId), asOf);
  if (!observation?.value_json) return null;
  const value = asRevisionLedgerValue(observation.value_json);
  if (value.case_id !== caseId || value.revision_id !== revisionId) throw new Error("clinical case revision ledger identity mismatch");
  const address = contentAddress(value.revision_digest);
  const bytes = await fs.readFile(cas.pathFor(address));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== address.digest.toLowerCase()) throw new Error(`clinical case revision '${revisionId}' CAS digest mismatch`);
  const revision = JSON.parse(bytes.toString("utf8")) as ClinicalCaseRevision;
  if (revision.schema !== CLINICAL_CASE_REVISION_SCHEMA || revision.caseId !== caseId || revision.revisionId !== revisionId) {
    throw new Error(`clinical case revision '${revisionId}' CAS object does not match its ledger identity`);
  }
  return {
    revision,
    summary: {
      caseId,
      revisionId,
      parentRevisionId: value.parent_revision_id,
      revisionDigest: value.revision_digest,
      revisionUri: value.revision_uri,
      memberCount: value.member_count,
      assetCount: value.asset_count,
      recordedAt: observation.recorded_at,
    },
  };
}

/** Register one immutable case input revision. It never overwrites raw assets or an existing revision id. */
export async function registerClinicalCaseRevision(
  workspace: string,
  request: RegisterClinicalCaseRevisionRequest,
): Promise<ClinicalCaseRevision> {
  const caseId = assertId("caseId", request.caseId);
  const recordedAt = request.recordedAt ?? new Date().toISOString();
  const members = normalizeMembers(request.members);
  const memberIds = new Set(members.map((member) => member.memberId));
  const indexMemberIds = [...new Set((request.indexMemberIds ?? []).map((memberId) => assertId("indexMemberId", memberId)))].sort();
  for (const memberId of indexMemberIds) {
    if (!memberIds.has(memberId)) throw new ClinicalCaseRegistryInputError(`index member '${memberId}' is not in the revision members`);
  }
  const assetInputs = [...request.assets];
  if (assetInputs.length === 0) throw new ClinicalCaseRegistryInputError("a case revision requires at least one asset");
  const assetIds = new Set<string>();
  for (const asset of assetInputs) {
    const assetId = assertId("assetId", asset.assetId);
    if (assetIds.has(assetId)) throw new ClinicalCaseRegistryInputError(`duplicate assetId '${assetId}'`);
    assetIds.add(assetId);
  }

  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const assets = await Promise.all(assetInputs.map((asset) => writeAsset(cas, asset, memberIds)));
  assets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  const relationships = normalizeRelationships(request.relationships ?? [], memberIds, assetIds);
  const parentRevisionId = request.parentRevisionId ? assertId("parentRevisionId", request.parentRevisionId) : undefined;
  const identity = {
    schema: CLINICAL_CASE_REVISION_SCHEMA,
    caseId,
    ...(parentRevisionId ? { parentRevisionId } : {}),
    indexMemberIds,
    members,
    relationships,
    assets: assets.map(({ digest, ...asset }) => ({ ...asset, digest })),
  } satisfies Omit<ClinicalCaseRevision, "revisionId">;
  const revisionId = request.revisionId
    ? assertId("revisionId", request.revisionId)
    : `r-${canonicalDigest(identity).slice("sha256:".length, "sha256:".length + 20)}`;
  const revision: ClinicalCaseRevision = {
    schema: CLINICAL_CASE_REVISION_SCHEMA,
    caseId,
    revisionId,
    ...(parentRevisionId ? { parentRevisionId } : {}),
    indexMemberIds,
    members,
    relationships,
    assets,
  };
  const bytes = encodeJson(revision as unknown as JsonValue);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const revisionDigest = `sha256:${digest}` as const;
  const revisionUri = `cas:${revisionDigest}` as const;
  await cas.put({ algorithm: "sha256", digest, sizeBytes: bytes.length, mediaType: CASE_REVISION_MEDIA_TYPE }, bytes);

  const store = await openBioStore(workspace);
  try {
    await inTransaction(store.conn, async () => {
      if (parentRevisionId) {
        const parent = await readRevisionFromLedger(store.conn, cas, caseId, parentRevisionId);
        if (!parent) throw new ClinicalCaseRegistryInputError(`parent revision '${parentRevisionId}' does not exist for case '${caseId}'`);
      }
      const existing = await readRevisionFromLedger(store.conn, cas, caseId, revisionId);
      if (existing) {
        if (existing.summary.revisionDigest !== revisionDigest) {
          throw new ClinicalCaseRegistryInputError(`revision '${revisionId}' already exists with different immutable content`);
        }
        return;
      }
      const caseNode = `case:${caseId}`;
      const node = revisionNode(caseId, revisionId);
      const revisionValue: RevisionLedgerValue = {
        schema: CLINICAL_CASE_REVISION_SCHEMA,
        case_id: caseId,
        revision_id: revisionId,
        parent_revision_id: revision.parentRevisionId ?? null,
        revision_digest: revisionDigest,
        revision_uri: revisionUri,
        member_count: revision.members.length,
        asset_count: revision.assets.length,
      };
      await recordObservation(store.conn, {
        statementKey: `clinical-case:${caseId}`,
        subjectId: caseNode,
        predicate: "clinical_case",
        value: { schema: "pi-bio.workbench.clinical_case.v1", case_id: caseId },
        recordedAt,
        source: SOURCE,
        digest: revisionDigest,
      });
      await recordObservation(store.conn, {
        statementKey: revisionStatementKey(caseId, revisionId),
        subjectId: node,
        predicate: "clinical_case_revision",
        value: revisionValue,
        recordedAt,
        source: SOURCE,
        digest: revisionDigest,
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: revisionDigest,
          mediaType: CASE_REVISION_MEDIA_TYPE,
          semanticRole: "clinical_case_revision",
          sizeBytes: bytes.length,
          attrs: { case_id: caseId, revision_id: revisionId },
        },
        subjectId: node,
        predicate: "produces",
        recordedAt,
        source: SOURCE,
        digest: revisionDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "clinical_case_revision" },
      });
      await recordObservationLink(store.conn, {
        subjectId: caseNode,
        predicate: "has_input_revision",
        objectId: node,
        recordedAt,
        source: SOURCE,
        digest: revisionDigest,
      });
      if (revision.parentRevisionId) {
        await recordObservationLink(store.conn, {
          subjectId: revisionNode(caseId, revision.parentRevisionId),
          predicate: "superseded_by",
          objectId: node,
          recordedAt,
          source: SOURCE,
          digest: revisionDigest,
        });
      }
      for (const member of revision.members) {
        const memberId = memberNode(caseId, revisionId, member.memberId);
        await recordObservation(store.conn, {
          statementKey: `clinical-case-member:${caseId}:${revisionId}:${member.memberId}`,
          subjectId: memberId,
          predicate: "clinical_case_member",
          value: { schema: "pi-bio.workbench.clinical_case_member.v1", case_id: caseId, revision_id: revisionId, member_id: member.memberId },
          recordedAt,
          source: SOURCE,
          digest: revisionDigest,
        });
        await recordObservationLink(store.conn, {
          subjectId: node,
          predicate: "has_member",
          objectId: memberId,
          recordedAt,
          source: SOURCE,
          digest: revisionDigest,
        });
      }
      for (const relationship of revision.relationships) {
        await recordObservationLink(store.conn, {
          subjectId: memberNode(caseId, revisionId, relationship.fromMemberId),
          predicate: `clinical:${relationship.predicate}`,
          objectId: memberNode(caseId, revisionId, relationship.toMemberId),
          recordedAt,
          source: SOURCE,
          digest: revisionDigest,
          attrs: relationship.sourceAssetId ? { source_asset_id: relationship.sourceAssetId } : undefined,
        });
      }
      for (const asset of revision.assets) {
        const nodeId = assetNode(caseId, revisionId, asset.assetId);
        await recordObservation(store.conn, {
          statementKey: `clinical-case-asset:${caseId}:${revisionId}:${asset.assetId}`,
          subjectId: nodeId,
          predicate: "clinical_case_asset",
          value: {
            schema: "pi-bio.workbench.clinical_case_asset.v1",
            case_id: caseId,
            revision_id: revisionId,
            asset_id: asset.assetId,
            kind: asset.kind,
            digest: asset.digest,
          },
          recordedAt,
          source: SOURCE,
          digest: asset.digest,
        });
        await recordObservationLink(store.conn, {
          subjectId: node,
          predicate: "has_asset",
          objectId: nodeId,
          recordedAt,
          source: SOURCE,
          digest: revisionDigest,
          attrs: { asset_id: asset.assetId, kind: asset.kind },
        });
        await recordArtifactReference(store.conn, {
          artifact: {
            digest: asset.digest,
            mediaType: asset.mediaType,
            semanticRole: asset.kind,
            sizeBytes: asset.sizeBytes,
            attrs: { case_id: caseId, revision_id: revisionId, asset_id: asset.assetId },
          },
          subjectId: nodeId,
          predicate: "references",
          recordedAt,
          source: SOURCE,
          digest: asset.digest,
          attrs: { asset_id: asset.assetId, kind: asset.kind },
          casMetadata: { conn: store.conn, refId: nodeId, refType: "clinical_case_asset" },
        });
      }
    });
  } finally {
    store.close();
  }
  return revision;
}

export async function getClinicalCaseRevision(
  workspace: string,
  caseId: string,
  revisionId: string,
  asOf = AS_OF,
): Promise<ClinicalCaseRevision | null> {
  return (await getClinicalCaseRevisionRecord(workspace, caseId, revisionId, asOf))?.revision ?? null;
}

export async function getClinicalCaseRevisionRecord(
  workspace: string,
  caseId: string,
  revisionId: string,
  asOf = AS_OF,
): Promise<ClinicalCaseRevisionRecord | null> {
  assertId("caseId", caseId);
  assertId("revisionId", revisionId);
  const store = await openBioStore(workspace);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  try {
    return await readRevisionFromLedger(store.conn, cas, caseId, revisionId, asOf);
  } finally {
    store.close();
  }
}

export async function listClinicalCaseRevisions(
  workspace: string,
  options: { caseId?: string; limit?: number; asOf?: string } = {},
): Promise<ClinicalCaseRevisionSummary[]> {
  if (options.caseId) assertId("caseId", options.caseId);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new ClinicalCaseRegistryInputError("limit must be an integer from 1 through 1000");
  const asOf = options.asOf ?? AS_OF;
  const store = await openBioStore(workspace);
  try {
    const rows = await store.conn.all<{ value_json: string; recorded_at: string }>(
      `WITH eligible AS (
         SELECT * FROM bio_observations
         WHERE predicate = 'clinical_case_revision'
           AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
           AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
           AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
       ), current AS (
         SELECT *, row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
         FROM eligible
       )
       SELECT value_json, recorded_at FROM current
       WHERE rn = 1
         AND (?::VARCHAR IS NULL OR json_extract_string(value_json, '$.case_id') = ?::VARCHAR)
       ORDER BY recorded_at::TIMESTAMPTZ DESC, statement_key DESC
       LIMIT ?`,
      [asOf, asOf, asOf, options.caseId ?? null, options.caseId ?? null, limit],
    );
    return rows
      .map((row) => {
        const value = asRevisionLedgerValue(row.value_json);
        return {
          caseId: value.case_id,
          revisionId: value.revision_id,
          parentRevisionId: value.parent_revision_id,
          revisionDigest: value.revision_digest,
          revisionUri: value.revision_uri,
          memberCount: value.member_count,
          assetCount: value.asset_count,
          recordedAt: row.recorded_at,
        } satisfies ClinicalCaseRevisionSummary;
      });
  } finally {
    store.close();
  }
}
