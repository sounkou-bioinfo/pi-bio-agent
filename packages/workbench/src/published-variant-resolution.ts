import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  type BioManifest,
  canonicalDigest,
  fsCasStore,
  inTransaction,
  observationAsOfKey,
  openBioStore,
  recordArtifactReference,
  recordObservation,
  recordObservationLink,
  runBioOperationFromManifest,
  type JsonValue,
  type SqlConn,
} from "pi-bio-agent";
import {
  getPublishedAcmgBenchmarkBundle,
  type ClassificationBenchmarkRow,
} from "./published-acmg-benchmark.js";

export const PUBLISHED_VARIANT_RESOLUTION_SCHEMA = "pi-bio.workbench.published_variant_resolution.v1" as const;
export const PUBLISHED_VARIANT_RESOLUTION_REGISTRATION_SCHEMA = "pi-bio.workbench.published_variant_resolution_registration.v1" as const;

const SOURCE = "pi-bio-workbench:published-variant-resolution";
const RESOLUTION_MEDIA_TYPE = "application/vnd.pi-bio.workbench.published-variant-resolution+json";
const AS_OF = "9999-12-31T23:59:59.999Z";
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export interface PublishedVariantSourceSnapshot {
  sourceId: "ncbi_variation_hgvs" | "ncbi_variation_rsids" | "ncbi_clinvar_search" | "ncbi_clinvar_summary";
  uri: string;
  retrievedAt: string;
  mediaType: string;
  digest: `sha256:${string}`;
  casUri: `cas:sha256:${string}`;
  sizeBytes: number;
  runId: string;
  receiptDigest: `sha256:${string}`;
}

export interface PublishedVariantClinVarIdentity {
  uid: string;
  accession: string;
  accessionVersion: string;
  title: string;
  canonicalSpdi: string;
  classification: string | null;
  reviewStatus: string | null;
  lastEvaluated: string | null;
  traits: Array<{ name: string; xrefs: Array<{ source: string; id: string }> }>;
}

export interface PublishedVariantResolution {
  schema: typeof PUBLISHED_VARIANT_RESOLUTION_SCHEMA;
  datasetId: string;
  version: string;
  rowId: string;
  sourceVariantText: string;
  genes: string[];
  transcriptHgvs: string;
  transcriptSpdi: string;
  rsids: string[];
  genomicLocation: {
    assembly: string;
    chromosome: string;
    position1Based: number;
    ref: string;
    alt: string;
    canonicalSpdi: string;
  } | null;
  clinvar: PublishedVariantClinVarIdentity | null;
  sourceSnapshots: PublishedVariantSourceSnapshot[];
}

export interface PublishedVariantResolutionRegistration {
  schema: typeof PUBLISHED_VARIANT_RESOLUTION_REGISTRATION_SCHEMA;
  datasetId: string;
  version: string;
  rowId: string;
  sourceVariantText: string;
  resolutionDigest: `sha256:${string}`;
  resolutionUri: `cas:sha256:${string}`;
  sourceDigests: `sha256:${string}`[];
  recordedAt: string;
}

export interface PublishedVariantFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type PublishedVariantFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<PublishedVariantFetchResponse>;

export interface ResolvePublishedVariantRequest {
  datasetId: string;
  version: string;
  rowId: string;
  fetch: PublishedVariantFetch;
  recordedAt?: string;
  forceRefresh?: boolean;
}

export class PublishedVariantResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedVariantResolutionError";
  }
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublishedVariantResolutionError(`${label} is not a JSON object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new PublishedVariantResolutionError(`${label} is not an array`);
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PublishedVariantResolutionError(`${label} is not a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

function resolutionStatementKey(datasetId: string, version: string, rowId: string): string {
  return `published-variant-resolution:${datasetId}:${version}:${rowId}`;
}

function benchmarkNode(datasetId: string, version: string): string {
  return `benchmark:${datasetId}@${version}`;
}

function rowNode(datasetId: string, version: string, rowId: string): string {
  return `benchmark-row:${datasetId}@${version}:${rowId}`;
}

function resolutionNode(datasetId: string, version: string, rowId: string): string {
  return `variant-resolution:${datasetId}@${version}:${rowId}`;
}

function extractTranscriptHgvs(variantText: string): string {
  const match = /^([A-Z]{2}_[0-9]+\.[0-9]+)(?:\([^)]*\))?:(c\.[^\s(]+)/.exec(variantText.trim());
  if (!match) {
    throw new PublishedVariantResolutionError(`variant '${variantText}' does not expose a supported transcript c.HGVS identity`);
  }
  return `${match[1]}:${match[2]}`;
}

function findClassificationRow(bundle: { classificationRows: ClassificationBenchmarkRow[] }, rowId: string): ClassificationBenchmarkRow {
  const row = bundle.classificationRows.find((candidate) => candidate.rowId === rowId);
  if (!row) throw new PublishedVariantResolutionError(`published benchmark row '${rowId}' was not found`);
  return row;
}

function sourceManifest(sourceId: PublishedVariantSourceSnapshot["sourceId"], uri: string): BioManifest {
  return {
    schema: "pi-bio.manifest.v1",
    id: "published-variant-source-resolution",
    version: "0.1.0",
    title: "Published variant source resolution",
    description: "Resolve one declared public variant identity source through the host-injected HTTP resolver.",
    provides: {
      resolvers: [{
        id: "http.get",
        version: "0.1.0",
        title: "HTTP GET to DuckDB table",
        description: "Fetch a declared JSON response through the host network port and retain its receipt/CAS bytes.",
        output: { mode: "table" },
      }],
      resources: [{
        id: "source_response",
        title: sourceId,
        kind: "virtual",
        resolver: "http.get",
        params: { table: "source_response", format: "json", method: "GET", url: uri },
      }],
      operations: [{
        id: "published_variant.read_source",
        version: "0.1.0",
        title: "Read one variant identity source response",
        description: "Return the declared source response as one JSON payload for source-specific validation.",
        transport: "duckdb.sql",
        inputSchema: { type: "object" },
        sql: {
          readOnly: true,
          requiredResources: ["source_response"],
          sqlTemplate: "SELECT to_json(source_response)::VARCHAR AS payload FROM source_response",
        },
      }],
    },
  };
}

function sourceRunId(sourceId: PublishedVariantSourceSnapshot["sourceId"], uri: string, recordedAt: string): string {
  const suffix = createHash("sha256").update(`${sourceId}\0${uri}\0${recordedAt}`).digest("hex").slice(0, 16);
  return `published-variant-source-${sourceId.replaceAll("_", "-")}-${suffix}`;
}

async function runJsonSource(
  fetcher: PublishedVariantFetch,
  sourceId: PublishedVariantSourceSnapshot["sourceId"],
  uri: string,
  retrievedAt: string,
  workspace: string,
): Promise<{ value: JsonRecord; snapshot: PublishedVariantSourceSnapshot }> {
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const store = await openBioStore(workspace);
  try {
    const runId = sourceRunId(sourceId, uri, retrievedAt);
    const response = await runBioOperationFromManifest({
      cwd: workspace,
      dbPath: ":memory:",
      manifestSnapshot: sourceManifest(sourceId, uri),
      manifestBaseDir: workspace,
      operationId: "published_variant.read_source",
      runId,
      now: retrievedAt,
      network: { fetch: fetcher },
      cas,
      store: store.conn,
      casMetadata: { conn: store.conn },
      author: SOURCE,
      serialize: false,
      remoteCacheScope: "public-ncbi-variant-resolution",
    });
    if (!response.ok) throw new PublishedVariantResolutionError(`${sourceId} source run failed: ${response.error}`);
    const row = response.result.rows[0] as { payload?: unknown } | undefined;
    if (response.rowCount !== 1 || typeof row?.payload !== "string") {
      throw new PublishedVariantResolutionError(`${sourceId} source run returned ${response.rowCount} rows instead of one JSON payload`);
    }
    const value = asRecord(JSON.parse(row.payload), sourceId);
    const receiptDigest = response.casRefs?.receipts;
    if (!receiptDigest || !SHA256_RE.test(receiptDigest)) {
      throw new PublishedVariantResolutionError(`${sourceId} source run completed without a receipt CAS digest`);
    }
    const receiptBytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: receiptDigest.slice("sha256:".length) }));
    const receipts = asArray(JSON.parse(receiptBytes.toString("utf8")), `${sourceId} receipts`).map((item) => asRecord(item, `${sourceId} receipt`));
    const receipt = receipts.find((item) => item.resourceId === "source_response");
    const sourceRows = receipt ? asArray(receipt.sourceSnapshots, `${sourceId} sourceSnapshots`) : [];
    const source = sourceRows.map((item) => asRecord(item, `${sourceId} source snapshot`))
      .find((item) => item.source === uri);
    const digest = optionalString(source?.version);
    if (!digest || !SHA256_RE.test(digest)) {
      throw new PublishedVariantResolutionError(`${sourceId} receipt did not retain the declared source digest`);
    }
    const sourcePath = cas.pathFor({ algorithm: "sha256", digest: digest.slice("sha256:".length) });
    const stat = await fs.stat(sourcePath);
    if (stat.size < 1 || stat.size > MAX_SOURCE_BYTES) {
      throw new PublishedVariantResolutionError(`${sourceId} retained ${stat.size} bytes; expected 1-${MAX_SOURCE_BYTES}`);
    }
    return {
      value,
      snapshot: {
        sourceId,
        uri,
        retrievedAt,
        mediaType: "application/json",
        digest: digest as `sha256:${string}`,
        casUri: `cas:${digest}` as `cas:sha256:${string}`,
        sizeBytes: stat.size,
        runId,
        receiptDigest: receiptDigest as `sha256:${string}`,
      },
    };
  } catch (error) {
    if (error instanceof PublishedVariantResolutionError) throw error;
    throw new PublishedVariantResolutionError(`${sourceId} source run failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    store.close();
  }
}

function transcriptSpdi(value: JsonRecord, transcriptHgvs: string): string {
  const data = asRecord(value.data, "NCBI HGVS data");
  const spdis = asArray(data.spdis, "NCBI HGVS spdis").map((item, index) => {
    const row = asRecord(item, `NCBI HGVS spdi ${index}`);
    const seqId = asString(row.seq_id, `NCBI HGVS spdi ${index} seq_id`);
    const position = Number(row.position);
    const deleted = asString(row.deleted_sequence, `NCBI HGVS spdi ${index} deleted_sequence`);
    const inserted = asString(row.inserted_sequence, `NCBI HGVS spdi ${index} inserted_sequence`);
    if (!Number.isInteger(position) || position < 0) throw new PublishedVariantResolutionError("NCBI HGVS SPDI position is invalid");
    return { seqId, value: `${seqId}:${position}:${deleted}:${inserted}` };
  });
  const accession = transcriptHgvs.split(":", 1)[0];
  const matches = spdis.filter((item) => item.seqId === accession);
  if (matches.length !== 1) throw new PublishedVariantResolutionError(`NCBI HGVS mapping returned ${matches.length} transcript SPDI matches for '${accession}'`);
  return matches[0]!.value;
}

function rsidsFrom(value: JsonRecord): string[] {
  const data = asRecord(value.data, "NCBI rsid data");
  return [...new Set(asArray(data.rsids, "NCBI rsids").map((item) => String(item).replace(/^rs/i, "")).filter(Boolean))]
    .sort((left, right) => Number(left) - Number(right));
}

function clinvarSearchIds(value: JsonRecord): string[] {
  const result = asRecord(value.esearchresult, "ClinVar search result");
  return asArray(result.idlist, "ClinVar search idlist").map((item) => asString(item, "ClinVar search id"));
}

function normalizedVariantText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function clinvarIdentity(
  value: JsonRecord,
  ids: string[],
  sourceVariantText: string,
  transcriptHgvs: string,
): { identity: PublishedVariantClinVarIdentity; genomicLocation: PublishedVariantResolution["genomicLocation"] } | null {
  if (ids.length === 0) return null;
  const result = asRecord(value.result, "ClinVar summary result");
  const candidates = ids.map((id) => asRecord(result[id], `ClinVar summary ${id}`));
  const exact = candidates.filter((candidate) => normalizedVariantText(String(candidate.title ?? "")) === normalizedVariantText(sourceVariantText));
  const transcriptMatches = exact.length ? exact : candidates.filter((candidate) => String(candidate.title ?? "").includes(transcriptHgvs));
  if (transcriptMatches.length !== 1) {
    throw new PublishedVariantResolutionError(`ClinVar search returned ${transcriptMatches.length} exact records for '${sourceVariantText}'`);
  }
  const item = transcriptMatches[0]!;
  const uid = asString(item.uid, "ClinVar uid");
  const variationSet = asArray(item.variation_set, "ClinVar variation_set");
  if (variationSet.length !== 1) throw new PublishedVariantResolutionError(`ClinVar record '${uid}' has ${variationSet.length} variation entries`);
  const variation = asRecord(variationSet[0], "ClinVar variation");
  const canonicalSpdi = asString(variation.canonical_spdi, "ClinVar canonical SPDI");
  const spdiParts = canonicalSpdi.split(":");
  if (spdiParts.length !== 4) throw new PublishedVariantResolutionError(`ClinVar canonical SPDI '${canonicalSpdi}' is invalid`);
  const locations = asArray(variation.variation_loc, "ClinVar variation locations").map((entry) => asRecord(entry, "ClinVar variation location"));
  const grch38 = locations.find((entry) => entry.assembly_name === "GRCh38" && entry.status === "current")
    ?? locations.find((entry) => entry.assembly_name === "GRCh38");
  if (!grch38) throw new PublishedVariantResolutionError(`ClinVar record '${uid}' has no GRCh38 location`);
  const position1Based = Number(grch38.start);
  if (!Number.isInteger(position1Based) || position1Based < 1) throw new PublishedVariantResolutionError("ClinVar GRCh38 position is invalid");
  const germline = item.germline_classification && typeof item.germline_classification === "object"
    ? asRecord(item.germline_classification, "ClinVar germline classification")
    : {};
  const traits = Array.isArray(germline.trait_set) ? germline.trait_set.map((entry) => {
    const trait = asRecord(entry, "ClinVar trait");
    const xrefs = Array.isArray(trait.trait_xrefs) ? trait.trait_xrefs.map((xref) => {
      const ref = asRecord(xref, "ClinVar trait xref");
      return { source: String(ref.db_source ?? ""), id: String(ref.db_id ?? "") };
    }).filter((xref) => xref.source && xref.id) : [];
    return { name: String(trait.trait_name ?? ""), xrefs };
  }).filter((trait) => trait.name) : [];
  return {
    identity: {
      uid,
      accession: asString(item.accession, "ClinVar accession"),
      accessionVersion: asString(item.accession_version, "ClinVar accession version"),
      title: asString(item.title, "ClinVar title"),
      canonicalSpdi,
      classification: optionalString(germline.description),
      reviewStatus: optionalString(germline.review_status),
      lastEvaluated: optionalString(germline.last_evaluated),
      traits,
    },
    genomicLocation: {
      assembly: "GRCh38",
      chromosome: asString(grch38.chr, "ClinVar chromosome"),
      position1Based,
      ref: spdiParts[2]!,
      alt: spdiParts[3]!,
      canonicalSpdi,
    },
  };
}

function parseRegistration(valueJson: string, recordedAt: string): PublishedVariantResolutionRegistration {
  const value = asRecord(JSON.parse(valueJson), "published variant resolution registration");
  if (value.schema !== PUBLISHED_VARIANT_RESOLUTION_REGISTRATION_SCHEMA) {
    throw new Error("published variant resolution registration has an invalid schema");
  }
  const resolutionDigest = asString(value.resolutionDigest, "resolutionDigest");
  if (!SHA256_RE.test(resolutionDigest)) throw new Error("published variant resolution digest is invalid");
  const sourceDigests = asArray(value.sourceDigests, "sourceDigests").map((digest) => asString(digest, "source digest"));
  if (sourceDigests.some((digest) => !SHA256_RE.test(digest))) throw new Error("published variant source digest is invalid");
  return {
    schema: PUBLISHED_VARIANT_RESOLUTION_REGISTRATION_SCHEMA,
    datasetId: asString(value.datasetId, "datasetId"),
    version: asString(value.version, "version"),
    rowId: asString(value.rowId, "rowId"),
    sourceVariantText: asString(value.sourceVariantText, "sourceVariantText"),
    resolutionDigest: resolutionDigest as `sha256:${string}`,
    resolutionUri: `cas:${resolutionDigest}` as `cas:sha256:${string}`,
    sourceDigests: sourceDigests as `sha256:${string}`[],
    recordedAt,
  };
}

async function readResolution(
  conn: SqlConn,
  workspace: string,
  datasetId: string,
  version: string,
  rowId: string,
  asOf = AS_OF,
): Promise<{ registration: PublishedVariantResolutionRegistration; resolution: PublishedVariantResolution } | null> {
  const observation = await observationAsOfKey(conn, resolutionStatementKey(datasetId, version, rowId), asOf);
  if (!observation?.value_json) return null;
  const registration = parseRegistration(observation.value_json, observation.recorded_at);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const digest = registration.resolutionDigest.slice("sha256:".length);
  const bytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest }));
  if (sha256(bytes) !== registration.resolutionDigest) throw new Error(`published variant resolution '${rowId}' CAS digest mismatch`);
  const resolution = JSON.parse(bytes.toString("utf8")) as PublishedVariantResolution;
  if (resolution.schema !== PUBLISHED_VARIANT_RESOLUTION_SCHEMA
    || resolution.datasetId !== datasetId
    || resolution.version !== version
    || resolution.rowId !== rowId
    || resolution.sourceVariantText !== registration.sourceVariantText) {
    throw new Error(`published variant resolution '${rowId}' does not match its ledger identity`);
  }
  return { registration, resolution };
}

export async function getPublishedVariantResolution(
  workspace: string,
  datasetId: string,
  version: string,
  rowId: string,
  asOf = AS_OF,
): Promise<{ registration: PublishedVariantResolutionRegistration; resolution: PublishedVariantResolution } | null> {
  const store = await openBioStore(workspace);
  try {
    return await readResolution(store.conn, workspace, datasetId, version, rowId, asOf);
  } finally {
    store.close();
  }
}

export async function resolvePublishedVariantWithNcbi(
  workspace: string,
  request: ResolvePublishedVariantRequest,
): Promise<{ registration: PublishedVariantResolutionRegistration; resolution: PublishedVariantResolution }> {
  const benchmark = await getPublishedAcmgBenchmarkBundle(workspace, request.datasetId, request.version);
  if (!benchmark) throw new PublishedVariantResolutionError(`published benchmark '${request.datasetId}@${request.version}' is not registered`);
  const row = findClassificationRow(benchmark.bundle, request.rowId);
  if (!request.forceRefresh) {
    const existing = await getPublishedVariantResolution(workspace, request.datasetId, request.version, request.rowId);
    if (existing) return existing;
  }
  const recordedAt = request.recordedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) throw new PublishedVariantResolutionError("recordedAt must be a valid timestamp");
  const transcriptHgvs = extractTranscriptHgvs(row.variantText);
  const hgvsUri = `https://api.ncbi.nlm.nih.gov/variation/v0/hgvs/${encodeURIComponent(transcriptHgvs)}/contextuals`;
  const hgvs = await runJsonSource(request.fetch, "ncbi_variation_hgvs", hgvsUri, recordedAt, workspace);
  const transcriptSpdiValue = transcriptSpdi(hgvs.value, transcriptHgvs);
  const rsidUri = `https://api.ncbi.nlm.nih.gov/variation/v0/spdi/${encodeURIComponent(transcriptSpdiValue)}/rsids`;
  const rsid = await runJsonSource(request.fetch, "ncbi_variation_rsids", rsidUri, recordedAt, workspace);
  const rsids = rsidsFrom(rsid.value);

  const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  search.searchParams.set("db", "clinvar");
  search.searchParams.set("term", transcriptHgvs);
  search.searchParams.set("retmode", "json");
  search.searchParams.set("retmax", "20");
  const clinvarSearch = await runJsonSource(request.fetch, "ncbi_clinvar_search", search.toString(), recordedAt, workspace);
  const clinvarIds = clinvarSearchIds(clinvarSearch.value);
  let clinvarSummary: Awaited<ReturnType<typeof runJsonSource>> | null = null;
  let resolvedClinvar: ReturnType<typeof clinvarIdentity> = null;
  if (clinvarIds.length) {
    const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
    summary.searchParams.set("db", "clinvar");
    summary.searchParams.set("id", clinvarIds.join(","));
    summary.searchParams.set("retmode", "json");
    clinvarSummary = await runJsonSource(request.fetch, "ncbi_clinvar_summary", summary.toString(), recordedAt, workspace);
    resolvedClinvar = clinvarIdentity(clinvarSummary.value, clinvarIds, row.variantText, transcriptHgvs);
  }
  const snapshots = [hgvs.snapshot, rsid.snapshot, clinvarSearch.snapshot, ...(clinvarSummary ? [clinvarSummary.snapshot] : [])];
  const resolution: PublishedVariantResolution = {
    schema: PUBLISHED_VARIANT_RESOLUTION_SCHEMA,
    datasetId: request.datasetId,
    version: request.version,
    rowId: row.rowId,
    sourceVariantText: row.variantText,
    genes: row.genes,
    transcriptHgvs,
    transcriptSpdi: transcriptSpdiValue,
    rsids,
    genomicLocation: resolvedClinvar?.genomicLocation ?? null,
    clinvar: resolvedClinvar?.identity ?? null,
    sourceSnapshots: snapshots,
  };
  const bytes = canonicalJsonBytes(resolution as unknown as JsonValue);
  const resolutionDigest = sha256(bytes);
  const resolutionUri = `cas:${resolutionDigest}` as const;
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  await cas.put({
    algorithm: "sha256",
    digest: resolutionDigest.slice("sha256:".length),
    sizeBytes: bytes.length,
    mediaType: RESOLUTION_MEDIA_TYPE,
  }, bytes);
  const registrationBody = {
    schema: PUBLISHED_VARIANT_RESOLUTION_REGISTRATION_SCHEMA,
    datasetId: request.datasetId,
    version: request.version,
    rowId: row.rowId,
    sourceVariantText: row.variantText,
    resolutionDigest,
    sourceDigests: snapshots.map((snapshot) => snapshot.digest),
  };
  const observationDigest = canonicalDigest(registrationBody);
  const registration: PublishedVariantResolutionRegistration = {
    ...registrationBody,
    resolutionUri,
    recordedAt,
  };
  const store = await openBioStore(workspace);
  try {
    await inTransaction(store.conn, async () => {
      const node = resolutionNode(request.datasetId, request.version, row.rowId);
      await recordObservation(store.conn, {
        statementKey: resolutionStatementKey(request.datasetId, request.version, row.rowId),
        subjectId: node,
        predicate: "resolves_variant_identity",
        value: registrationBody,
        recordedAt,
        source: SOURCE,
        digest: observationDigest,
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: resolutionDigest,
          mediaType: RESOLUTION_MEDIA_TYPE,
          semanticRole: "resolved_variant_identity",
          sizeBytes: bytes.length,
          attrs: { dataset_id: request.datasetId, version: request.version, row_id: row.rowId },
        },
        subjectId: node,
        predicate: "produces",
        recordedAt,
        source: SOURCE,
        digest: observationDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "resolved_variant_identity" },
      });
      for (const snapshot of snapshots) {
        await recordArtifactReference(store.conn, {
          artifact: {
            digest: snapshot.digest,
            mediaType: snapshot.mediaType,
            semanticRole: "variant_identity_source_snapshot",
            sizeBytes: snapshot.sizeBytes,
            attrs: { source_id: snapshot.sourceId, source_uri: snapshot.uri, retrieved_at: snapshot.retrievedAt },
          },
          subjectId: node,
          predicate: "uses_source",
          recordedAt,
          source: SOURCE,
          digest: snapshot.digest,
          casMetadata: { conn: store.conn, refId: `${node}:${snapshot.sourceId}`, refType: "variant_identity_source_snapshot" },
        });
        await recordObservationLink(store.conn, {
          subjectId: node,
          predicate: "uses_run",
          objectId: `run:${snapshot.runId}`,
          recordedAt,
          source: SOURCE,
          digest: snapshot.receiptDigest,
        });
      }
      await recordObservationLink(store.conn, {
        subjectId: benchmarkNode(request.datasetId, request.version),
        predicate: "has_variant_row",
        objectId: rowNode(request.datasetId, request.version, row.rowId),
        recordedAt,
        source: SOURCE,
        digest: benchmark.registration.normalizedDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "resolves",
        objectId: rowNode(request.datasetId, request.version, row.rowId),
        recordedAt,
        source: SOURCE,
        digest: resolutionDigest,
      });
    });
  } finally {
    store.close();
  }
  return { registration, resolution };
}
