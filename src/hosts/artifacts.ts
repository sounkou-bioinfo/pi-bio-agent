import type { TrustBlock } from "../core/knowledge-graph.js";
import type { SqlConn } from "../core/ports.js";
import { contentAddressUri, type ContentAddress } from "../core/resources.js";
import { validateContentAddress } from "../core/storage.js";
import { createBioObservationSchema, recordMonotonicObservation, recordObservation, recordObservationLink } from "../duckdb/observations.js";
import { addCasRef, initCasMetadata, recordCasObject } from "./cas-metadata.js";

export interface CasArtifactFact {
  digest: `sha256:${string}`;
  mediaType?: string;
  semanticRole?: string;
  sizeBytes?: number;
  attrs?: Record<string, unknown>;
}

export interface ArtifactReferenceInput {
  artifact: CasArtifactFact;
  /** Caller-owned graph node that displays, produces, consumes, or otherwise references the artifact. */
  subjectId: string;
  /** Caller-owned relationship, commonly `produces` or `displays`. */
  predicate: string;
  recordedAt: string;
  source?: string;
  digest?: string;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
  factStatementKey?: string;
  referenceStatementKey?: string;
  /** Optional shared-CAS metadata authority. Pass only after the artifact bytes have been written to that CAS. */
  casMetadata?: { conn: SqlConn; nowMs?: number; refId?: string; refType?: string };
  /** Use for stateful artifact slots whose current reference must supersede older rows, e.g. run-produced outputs. */
  referenceMonotonic?: { sentinel: string };
}

export interface ArtifactReferenceRecord {
  artifactObservationId: string;
  referenceObservationId: string;
  casUri: `cas:sha256:${string}`;
}

function assertNonEmpty(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`recordArtifactReference: ${label} must be non-empty`);
  return trimmed;
}

function contentAddressFromDigest(digest: `sha256:${string}`, sizeBytes: number | undefined, mediaType: string | undefined): ContentAddress {
  const address: ContentAddress = { algorithm: "sha256", digest: digest.slice("sha256:".length), sizeBytes, mediaType };
  const errors = validateContentAddress(address);
  if (errors.length) throw new Error(`recordArtifactReference: invalid artifact digest (${errors.join("; ")})`);
  return address;
}

/** Record a CAS-addressed artifact plus one graph reference to it.
 *
 * The artifact fact is intrinsic byte metadata on `cas:<digest>`. The reference edge carries context such as the
 * producing run, displayed turn, source/spec digest, plotting system, or workflow step. This keeps figures,
 * generated reports, and session images on the same observation/edge substrate without introducing a plot table.
 */
export async function recordArtifactReference(conn: SqlConn, input: ArtifactReferenceInput): Promise<ArtifactReferenceRecord> {
  const subjectId = assertNonEmpty("subjectId", input.subjectId);
  const predicate = assertNonEmpty("predicate", input.predicate);
  const address = contentAddressFromDigest(input.artifact.digest, input.artifact.sizeBytes, input.artifact.mediaType);
  const casUri = contentAddressUri(address) as `cas:sha256:${string}`;
  const artifactValue: Record<string, unknown> = {
    digest: input.artifact.digest,
    uri: casUri,
  };
  if (input.artifact.mediaType !== undefined) artifactValue.media_type = input.artifact.mediaType;
  if (input.artifact.semanticRole !== undefined) artifactValue.semantic_role = input.artifact.semanticRole;
  if (input.artifact.sizeBytes !== undefined) artifactValue.size_bytes = input.artifact.sizeBytes;

  const artifactAttrs = { ...(input.artifact.attrs ?? {}) };
  if (input.artifact.mediaType !== undefined) artifactAttrs.media_type = input.artifact.mediaType;
  if (input.artifact.semanticRole !== undefined) artifactAttrs.semantic_role = input.artifact.semanticRole;

  const referenceAttrs = { ...(input.attrs ?? {}) };
  if (input.artifact.mediaType !== undefined && referenceAttrs.media_type === undefined) referenceAttrs.media_type = input.artifact.mediaType;
  if (input.artifact.semanticRole !== undefined && referenceAttrs.semantic_role === undefined) referenceAttrs.semantic_role = input.artifact.semanticRole;

  if (input.casMetadata) {
    const nowMs = input.casMetadata.nowMs ?? Date.now();
    await initCasMetadata(input.casMetadata.conn);
    await recordCasObject(input.casMetadata.conn, address, input.artifact.sizeBytes ?? null, nowMs);
    await addCasRef(input.casMetadata.conn, {
      refId: input.casMetadata.refId ?? casUri,
      refType: input.casMetadata.refType ?? "artifact",
      address,
    }, nowMs);
  }

  await createBioObservationSchema(conn, { ifNotExists: true });
  const artifactObservationId = await recordObservation(conn, {
    statementKey: input.factStatementKey ?? `${casUri}:artifact`,
    subjectId: casUri,
    predicate: "artifact",
    value: artifactValue,
    recordedAt: input.recordedAt,
    source: input.source,
    digest: input.artifact.digest,
    attrs: artifactAttrs,
    trust: input.trust,
  });
  const referenceStatementKey = input.referenceStatementKey ?? `${subjectId}:${predicate}:${casUri}`;
  const referenceObservationId = input.referenceMonotonic
    ? await recordMonotonicObservation(conn, {
      statementKey: referenceStatementKey,
      subjectId,
      predicate,
      objectId: casUri,
      source: input.source,
      digest: input.digest ?? input.artifact.digest,
      attrs: referenceAttrs,
      trust: input.trust,
    }, input.recordedAt, input.referenceMonotonic.sentinel)
    : await recordObservationLink(conn, {
      statementKey: referenceStatementKey,
      subjectId,
      predicate,
      objectId: casUri,
      recordedAt: input.recordedAt,
      source: input.source,
      digest: input.digest ?? input.artifact.digest,
      attrs: referenceAttrs,
      trust: input.trust,
    });

  return { artifactObservationId, referenceObservationId, casUri };
}
