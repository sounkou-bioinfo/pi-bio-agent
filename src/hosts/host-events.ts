import type { SqlConn } from "../core/ports.js";
import type { TrustBlock } from "../core/knowledge-graph.js";
import { canonicalDigest } from "../core/reproducibility.js";
import { createBioObservationSchema, recordObservation, recordObservationLink } from "../duckdb/observations.js";

export interface HostEventLink {
  /** Caller-owned relationship from the event subject to another graph node. */
  predicate: string;
  objectId: string;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
  digest?: string;
  statementKey?: string;
  observationId?: string;
}

export interface HostEventInput {
  /** Existing or caller-owned node the event is about: session:<id>, turn:<id>, run:<id>, workflow:<id>, etc. */
  subjectId: string;
  /** Open host-owned event kind. Core stores it, but never branches on a host vocabulary. */
  kind: string;
  recordedAt: string;
  /** Small structured event payload. Store large/secret payloads in CAS/redacted views and reference digests here. */
  value?: unknown;
  source?: string;
  digest?: string;
  attrs?: Record<string, unknown>;
  trust?: TrustBlock;
  /** Optional state slot. Defaults to one event slot per subject/kind/content hash. */
  statementKey?: string;
  observationId?: string;
  links?: HostEventLink[];
}

export interface HostEventRecordResult {
  observationId: string;
  statementKey: string;
  linkObservationIds: string[];
}

function nonEmpty(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`recordHostEvent: ${label} must be non-empty`);
  return trimmed;
}

function defaultStatementKey(subjectId: string, kind: string, recordedAt: string, source: string | undefined, digest: string | undefined, value: unknown): string {
  return `${subjectId}:host_event:${canonicalDigest([subjectId, kind, recordedAt, source ?? null, digest ?? null, value ?? null])}`;
}

function defaultObservationId(statementKey: string, subjectId: string, kind: string, recordedAt: string, source: string | undefined, digest: string | undefined, value: unknown): `sha256:${string}` {
  return canonicalDigest(["host_event", statementKey, subjectId, kind, recordedAt, source ?? null, digest ?? null, value ?? null]);
}

/** Record a runtime host event that persisted transcripts cannot reconstruct.
 *
 * This is deliberately only a typed convenience over `bio_observations`: one scalar `host_event` fact, plus optional
 * ordinary edge-like observations. Event `kind` is an open host-owned string, not a core taxonomy. A workbench app,
 * a scheduler, or any other host can use its own vocabulary without making that vocabulary part of core.
 */
export async function recordHostEvent(conn: SqlConn, event: HostEventInput): Promise<HostEventRecordResult> {
  const subjectId = nonEmpty("subjectId", event.subjectId);
  const kind = nonEmpty("kind", event.kind);
  const value = event.value === undefined ? { kind } : { kind, value: event.value };
  const attrs = { ...(event.attrs ?? {}), kind };
  const statementKey = event.statementKey ?? defaultStatementKey(subjectId, kind, event.recordedAt, event.source, event.digest, event.value);
  const eventObservationId = event.observationId ?? defaultObservationId(statementKey, subjectId, kind, event.recordedAt, event.source, event.digest, event.value);
  const links = (event.links ?? []).map((link) => ({
    ...link,
    predicate: nonEmpty("link.predicate", link.predicate),
    objectId: nonEmpty("link.objectId", link.objectId),
  }));
  await createBioObservationSchema(conn, { ifNotExists: true });
  const observationId = await recordObservation(conn, {
    statementKey,
    subjectId,
    predicate: "host_event",
    value,
    recordedAt: event.recordedAt,
    source: event.source,
    digest: event.digest,
    attrs,
    trust: event.trust,
    observationId: eventObservationId,
  });

  const linkObservationIds: string[] = [];
  for (const link of links) {
    linkObservationIds.push(await recordObservationLink(conn, {
      subjectId,
      predicate: link.predicate,
      objectId: link.objectId,
      recordedAt: event.recordedAt,
      source: event.source,
      digest: link.digest ?? event.digest,
      attrs: { ...(link.attrs ?? {}), host_event_kind: kind },
      trust: link.trust ?? event.trust,
      statementKey: link.statementKey,
      observationId: link.observationId,
    }));
  }

  return { observationId, statementKey, linkObservationIds };
}
