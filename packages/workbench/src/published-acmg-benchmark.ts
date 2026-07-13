import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import readXlsxFile, { type Sheet } from "read-excel-file/node";
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
  type JsonValue,
  type RunCasRefs,
  type SqlConn,
} from "pi-bio-agent";

export const PUBLISHED_ACMG_BENCHMARK_SCHEMA = "pi-bio.workbench.published_acmg_benchmark.v1" as const;
export const PUBLISHED_ACMG_BENCHMARK_REGISTRATION_SCHEMA = "pi-bio.workbench.published_acmg_benchmark_registration.v1" as const;

const SOURCE = "pi-bio-workbench:published-acmg-benchmark";
const WORKBOOK_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BUNDLE_MEDIA_TYPE = "application/vnd.pi-bio.workbench.published-acmg-benchmark+json";
const AS_OF = "9999-12-31T23:59:59.999Z";
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const DATASET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MEDIA_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;.*)?$/;

export type PublishedAcmgDatasetRole =
  | "rule_development"
  | "authored_knowledge"
  | "external_validation"
  | "external_reanalysis";

const DATASET_ROLES: readonly PublishedAcmgDatasetRole[] = [
  "rule_development",
  "authored_knowledge",
  "external_validation",
  "external_reanalysis",
];

export type AcmgClassification =
  | "benign"
  | "likely_benign"
  | "uncertain_significance"
  | "likely_pathogenic"
  | "pathogenic";

export type AcmgSourceClassification = AcmgClassification | "conflicting_classifications";
export type AcmgCriterionStrength = "default" | "supporting" | "moderate" | "strong" | "very_strong";
export type CriterionSourceFlag = "none" | "wrong_strength" | "wrong_raw_score";
export type WorkbookCell = string | number | boolean | null;

export interface PublishedAcmgWorkbookSheet {
  sheet: string;
  data: WorkbookCell[][];
}

export interface AcmgCriterionApplication {
  raw: string;
  code: string | null;
  strength: AcmgCriterionStrength | null;
  applied: boolean | null;
  context?: string;
  sourceFlag: CriterionSourceFlag;
  parseStatus: "parsed" | "unparsed";
}

export interface NormalizedClassification {
  raw: string;
  normalized: AcmgClassification;
  normalizationNotes: string[];
}

export interface NormalizedSourceClassification {
  raw: string;
  normalized: AcmgSourceClassification;
  normalizationNotes: string[];
}

export interface WorkbookVariantIdentity {
  status: "unresolved";
  sourceText: string;
  reason: string;
}

export interface RuleDevelopmentRow {
  rowId: string;
  datasetRole: "rule_development";
  sheet: string;
  sourceRow: number;
  criterionFamily: string;
  variantText: string;
  identity: WorkbookVariantIdentity;
  expectedApplication: "rule_positive" | "rule_negative";
  expectedCriterion: AcmgCriterionApplication | null;
  publicationPmids: string[];
  modelConcordance: {
    deepseekR1: boolean;
    o3MiniHigh: boolean;
  };
  rawCells: Record<string, WorkbookCell>;
}

export interface AuthoredKnowledgeRow {
  rowId: string;
  datasetRole: "authored_knowledge";
  sheet: string;
  sourceRow: number;
  topic: "gene_disease_consistency" | "segregation_points" | "pp4_knowledge" | "ps4_thresholds";
  rowKind: "entry" | "note";
  fields: Record<string, WorkbookCell>;
}

export interface ModelClassificationAssessment {
  criteriaRaw: string;
  criteria: AcmgCriterionApplication[];
  classification: NormalizedClassification;
  reportedConcordant: boolean;
  computedConcordant: boolean;
  concordanceConsistent: boolean;
}

export interface ClassificationBenchmarkRow {
  rowId: string;
  datasetRole: "external_validation" | "external_reanalysis";
  sheet: string;
  sourceRow: number;
  genes: string[];
  variantText: string;
  identity: WorkbookVariantIdentity;
  sourceClassification: NormalizedSourceClassification;
  literatureIndependentCriteriaRaw: string;
  literatureIndependentCriteria: AcmgCriterionApplication[];
  humanCriteriaRaw: string;
  humanCriteria: AcmgCriterionApplication[];
  referenceClassification: NormalizedClassification;
  sourceSubmissionSummary?: string;
  publicationCount?: number;
  modelAssessments: {
    deepseekR1: ModelClassificationAssessment;
    o3MiniHigh: ModelClassificationAssessment;
  };
  unparsedCriterionCount: number;
  rawCells: Record<string, WorkbookCell>;
}

export interface WorkbookSourceNote {
  sheet: string;
  sourceRow: number;
  text: string;
}

export interface PublishedAcmgBenchmarkBundle {
  schema: typeof PUBLISHED_ACMG_BENCHMARK_SCHEMA;
  datasetId: string;
  version: string;
  source: {
    uri: string;
    citation: string;
    workbookDigest: `sha256:${string}`;
    containerDigest?: `sha256:${string}`;
  };
  adapter: {
    id: "pi-bio-workbench.published-acmg-workbook";
    version: "0.1.0";
    libraries: {
      workbook: "read-excel-file@9.3.1";
      container: "fflate@0.8.3";
    };
    contractDigest: `sha256:${string}`;
  };
  sheets: Array<{
    name: string;
    title: string;
    datasetRole: PublishedAcmgDatasetRole;
    rowCount: number;
  }>;
  ruleDevelopmentRows: RuleDevelopmentRow[];
  authoredKnowledgeRows: AuthoredKnowledgeRow[];
  classificationRows: ClassificationBenchmarkRow[];
  sourceNotes: WorkbookSourceNote[];
  quality: {
    roleCounts: Record<PublishedAcmgDatasetRole, number>;
    unresolvedVariantIdentities: number;
    unparsedCriterionTokens: Array<{ rowId: string; raw: string }>;
    reportedConcordanceMismatches: Array<{
      rowId: string;
      actor: "deepseek_r1" | "o3_mini_high";
      reportedConcordant: boolean;
      computedConcordant: boolean;
    }>;
  };
}

export interface RegisterPublishedAcmgWorkbookRequest {
  datasetId: string;
  version: string;
  sourceUri: string;
  citation: string;
  workbookBytes: Buffer | Uint8Array;
  expectedWorkbookDigest: `sha256:${string}`;
  sourceContainer?: {
    bytes: Buffer | Uint8Array;
    expectedDigest: `sha256:${string}`;
    mediaType: string;
  };
  recordedAt?: string;
  validationRunId?: string;
  /** The published workbook contract is strict by default. Tests for parser mechanics may disable count checks. */
  enforcePublishedCounts?: boolean;
}

export interface RegisterPublishedAcmgWorkbookFileRequest extends Omit<RegisterPublishedAcmgWorkbookRequest, "workbookBytes"> {
  workbookPath: string;
}

export interface RegisterPublishedAcmgWorkbookArchiveFileRequest extends Omit<RegisterPublishedAcmgWorkbookRequest, "workbookBytes" | "sourceContainer"> {
  archivePath: string;
  expectedArchiveDigest: `sha256:${string}`;
}

export interface PublishedAcmgBenchmarkRegistration {
  schema: typeof PUBLISHED_ACMG_BENCHMARK_REGISTRATION_SCHEMA;
  datasetId: string;
  version: string;
  sourceUri: string;
  citation: string;
  rawDigest: `sha256:${string}`;
  rawUri: `cas:sha256:${string}`;
  containerDigest?: `sha256:${string}`;
  containerUri?: `cas:sha256:${string}`;
  normalizedDigest: `sha256:${string}`;
  normalizedUri: `cas:sha256:${string}`;
  adapterContractDigest: `sha256:${string}`;
  roleCounts: Record<PublishedAcmgDatasetRole, number>;
  validationRunId: string;
  validationCasRefs: RunCasRefs;
  registrationDigest: `sha256:${string}`;
  recordedAt: string;
}

export class PublishedAcmgBenchmarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedAcmgBenchmarkInputError";
  }
}

type SheetSpec = {
  role: PublishedAcmgDatasetRole;
  headers: readonly string[];
  expectedRows: number;
};

const RULE_SHEET_FAMILIES = new Map<string, string>([
  ["ST1_PVS1", "PVS1_RNA"],
  ["ST2_PS2", "PS2_PM6"],
  ["ST3_PS3", "PS3"],
  ["ST4_PS4", "PS4"],
  ["ST5_PM3", "PM3"],
  ["ST6_PP1", "PP1"],
  ["ST7_PP4", "PP4"],
]);

const KNOWLEDGE_TOPICS = new Map<string, AuthoredKnowledgeRow["topic"]>([
  ["ST8_Gene-disease consistency", "gene_disease_consistency"],
  ["ST9_modified PP1", "segregation_points"],
  ["ST10_PP4 knowledgebase", "pp4_knowledge"],
  ["ST11_PS4 thresholds", "ps4_thresholds"],
]);

const SHEET_SPECS = new Map<string, SheetSpec>([
  ["ST1_PVS1", { role: "rule_development", expectedRows: 100, headers: ["Variant", "PVS1 (RNA) applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST2_PS2", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PS2/PM6 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST3_PS3", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PS3 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST4_PS4", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PS4 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST5_PM3", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PM3 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST6_PP1", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PP1 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST7_PP4", { role: "rule_development", expectedRows: 150, headers: ["Variant", "PP4 applied?", "Strength", "Publication used (PMID)", "DeepSeek-R1 concordance", "o3-mini-high concordance"] }],
  ["ST8_Gene-disease consistency", { role: "authored_knowledge", expectedRows: 44, headers: ["Specificity", "Genes", "Disease/Phenotypes"] }],
  ["ST9_modified PP1", { role: "authored_knowledge", expectedRows: 12, headers: ["Segregation", "Genotype", "Phenotype", "Points per individual", "Remark"] }],
  ["ST10_PP4 knowledgebase", { role: "authored_knowledge", expectedRows: 82, headers: ["Disease", "Gene", "Clinical observable phenotype", "Regular/genetic tests", "Specific tests", "PP4 evidence level to be assigned"] }],
  ["ST11_PS4 thresholds", { role: "authored_knowledge", expectedRows: 42, headers: ["Gene", "MOI", "Disease", "Preval. Orphanet", "Preval. GeneReviews", "Phenotype Specificity", "Supporting", "Moderate", "Strong", "Very Strong"] }],
  ["ST12_150 ClinGen varinats", { role: "external_validation", expectedRows: 150, headers: ["Gene(s)", "Variant Details", "ClinGen classifcation", "Reaccessed literature-independent ACMG rules", "Reaccessed literature-dependent rules according to general ACMG guideline (human curator)", "Human curator classification", "Literature-dependent rules applied by DeepSeek-R1", "DeepSeek-R1 classification", "Classification matches human curator (DeepSeek-R1)", "o3-mini-high applied rules", "o3-mini-high classification", "Classification matches human curator (o3-mini-high)"] }],
  ["ST13_150 ClinVar variants", { role: "external_reanalysis", expectedRows: 150, headers: ["Gene(s)", "Variant Details", "ClinVar classifcation", "Submissions contributed to ClinVar conflicting classification", "Literature-independent ACMG rules", "Literature-dependent rules according to general ACMG guideline (human curator)", "Number of publication analyzed", "Human curator classification", "Literature-dependent rules applied by DeepSeek-R1", "DeepSeek-R1 classification", "Classification matches human curator (DeepSeek-R1)", "o3-mini-high applied rules", "o3-mini-high classification", "Classification matches human curator (o3-mini-high)"] }],
]);

const ADAPTER_CONTRACT_DIGEST = canonicalDigest({
  id: "pi-bio-workbench.published-acmg-workbook",
  version: "0.1.0",
  libraries: {
    workbook: "read-excel-file@9.3.1",
    container: "fflate@0.8.3",
  },
  sheetSpecs: [...SHEET_SPECS.entries()],
  roles: DATASET_ROLES,
  identityPolicy: "unresolved_until_release_pinned_mapping",
});

function assertText(label: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PublishedAcmgBenchmarkInputError(`${label} must be non-empty`);
  return value.trim();
}

function assertDatasetId(label: string, value: unknown): string {
  const text = assertText(label, value);
  if (!DATASET_ID_RE.test(text)) throw new PublishedAcmgBenchmarkInputError(`${label} must match ${DATASET_ID_RE}`);
  return text;
}

function assertDigest(label: string, value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new PublishedAcmgBenchmarkInputError(`${label} must be sha256:<64 lowercase hex characters>`);
  }
  return value as `sha256:${string}`;
}

function assertTimestamp(label: string, value: unknown): string {
  const text = assertText(label, value);
  if (!Number.isFinite(Date.parse(text))) throw new PublishedAcmgBenchmarkInputError(`${label} must be a valid timestamp`);
  return new Date(text).toISOString();
}

function assertMediaType(label: string, value: unknown): string {
  const text = assertText(label, value);
  if (!MEDIA_TYPE_RE.test(text)) throw new PublishedAcmgBenchmarkInputError(`${label} must be a valid media type`);
  return text;
}

function assertRoleCounts(value: unknown): Record<PublishedAcmgDatasetRole, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("published ACMG benchmark ledger value has invalid roleCounts");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((role) => !DATASET_ROLES.includes(role as PublishedAcmgDatasetRole))) {
    throw new Error("published ACMG benchmark ledger value has unknown roleCounts entries");
  }
  return Object.fromEntries(DATASET_ROLES.map((role) => {
    const count = item[role];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`published ACMG benchmark ledger value has an invalid '${role}' role count`);
    }
    return [role, count];
  })) as Record<PublishedAcmgDatasetRole, number>;
}

function assertRunCasRefs(value: unknown): RunCasRefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("published ACMG benchmark ledger value has invalid validationCasRefs");
  }
  const item = value as Record<string, unknown>;
  const refs: RunCasRefs = {};
  for (const key of ["result", "receipts", "replay", "runObject"] as const) {
    refs[key] = assertDigest(`validationCasRefs.${key}`, item[key]);
  }
  return refs;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
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

function casAddress(digest: `sha256:${string}`): { algorithm: "sha256"; digest: string } {
  return { algorithm: "sha256", digest: digest.slice("sha256:".length) };
}

async function putCas(cas: CasStore, bytes: Uint8Array, mediaType: string): Promise<{ digest: `sha256:${string}`; uri: `cas:sha256:${string}`; sizeBytes: number }> {
  const digest = sha256(bytes);
  await cas.put({ ...casAddress(digest), sizeBytes: bytes.length, mediaType }, Buffer.from(bytes));
  return { digest, uri: `cas:${digest}`, sizeBytes: bytes.length };
}

// read-excel-file currently returns XML entities from shared strings verbatim. Decode exactly one XML layer so the
// normalized HGVS text matches what spreadsheet users see while preserving an intentionally literal "&gt;" value.
function decodeSpreadsheetText(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos);/gi, (entity, key: string) => {
    const lower = key.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const numeric = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

function normalizeCell(value: unknown): WorkbookCell {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return decodeSpreadsheetText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  throw new PublishedAcmgBenchmarkInputError(`unsupported workbook cell value '${String(value)}'`);
}

function cellText(value: WorkbookCell | undefined): string {
  if (value == null) return "";
  return String(value).trim();
}

function normalizedHeader(value: WorkbookCell | undefined): string {
  return cellText(value).replace(/\s+/g, " ");
}

function rowHasValue(row: readonly WorkbookCell[]): boolean {
  return row.some((value) => value !== null && cellText(value) !== "");
}

function headersFor(sheet: PublishedAcmgWorkbookSheet, spec: SheetSpec): string[] {
  const headerRow = sheet.data[1];
  if (!headerRow) throw new PublishedAcmgBenchmarkInputError(`sheet '${sheet.sheet}' has no header row`);
  const actual = spec.headers.map((_, index) => normalizedHeader(headerRow[index]));
  const expected = spec.headers.map((header) => normalizedHeader(header));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PublishedAcmgBenchmarkInputError(`sheet '${sheet.sheet}' headers do not match the published contract`);
  }
  return expected;
}

function rawCells(headers: readonly string[], row: readonly WorkbookCell[]): Record<string, WorkbookCell> {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]));
}

function unresolvedIdentity(variantText: string): WorkbookVariantIdentity {
  return {
    status: "unresolved",
    sourceText: variantText,
    reason: "The workbook supplies variant text but no stable VCV, RCV, SCV, or ClinGen allele accession; map against a pinned source release before temporal evaluation.",
  };
}

function parseYesNo(label: string, value: WorkbookCell | undefined): boolean {
  const text = cellText(value).toUpperCase();
  if (text === "Y") return true;
  if (text === "N") return false;
  throw new PublishedAcmgBenchmarkInputError(`${label} must be Y or N`);
}

function parsePmids(value: WorkbookCell | undefined): string[] {
  const matches = cellText(value).match(/\d{5,9}/g) ?? [];
  return [...new Set(matches)];
}

function criterionStrength(value: string | undefined): AcmgCriterionStrength | null {
  if (!value) return "default";
  const normalized = value.replace(/[\s_-]+/g, "").toLowerCase();
  if (normalized === "supporting") return "supporting";
  if (normalized === "moderate") return "moderate";
  if (normalized === "strong") return "strong";
  if (normalized === "verystrong") return "very_strong";
  return null;
}

export function parseAcmgCriterionToken(rawInput: string): AcmgCriterionApplication {
  const raw = rawInput.trim();
  const marker = raw.match(/^#+/)?.[0].length ?? 0;
  const sourceFlag: CriterionSourceFlag = marker === 1 ? "wrong_strength" : marker >= 2 ? "wrong_raw_score" : "none";
  let body = raw.slice(marker).trim().replace(/_\s+/g, "_");
  const notApplied = /\(\s*not applied\s*\)/i.test(body);
  body = body.replace(/\(\s*not applied\s*\)/ig, "").trim();
  const match = body.match(/^(PVS1|PS[1-4]|PM[1-6]|PP[1-5]|BA1|BS[1-4]|BP[1-7])(?:_([A-Za-z ]+))?(?:\s*\(([^)]+)\))?$/i);
  if (!match) {
    return { raw, code: null, strength: null, applied: null, sourceFlag, parseStatus: "unparsed" };
  }
  const strength = criterionStrength(match[2]);
  if (strength === null) {
    return { raw, code: null, strength: null, applied: null, sourceFlag, parseStatus: "unparsed" };
  }
  const context = match[3]?.trim();
  return {
    raw,
    code: match[1]!.toUpperCase(),
    strength,
    applied: !notApplied,
    ...(context ? { context } : {}),
    sourceFlag,
    parseStatus: "parsed",
  };
}

export function parseAcmgCriteria(value: WorkbookCell | undefined): AcmgCriterionApplication[] {
  const text = cellText(value);
  if (!text || text.toUpperCase() === "NA") return [];
  const tokens: string[] = [];
  let start = 0;
  let squareDepth = 0;
  let roundDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "(") roundDepth += 1;
    else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (character === "," && squareDepth === 0 && roundDepth === 0) {
      const token = text.slice(start, index).trim();
      if (token) tokens.push(token);
      start = index + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) tokens.push(tail);
  return tokens.map(parseAcmgCriterionToken);
}

function normalizeClassification(value: WorkbookCell | undefined): NormalizedClassification {
  const raw = cellText(value);
  const repaired = raw.replace(/^Likley /i, "Likely ");
  const key = repaired.toLowerCase();
  const normalized = new Map<string, AcmgClassification>([
    ["b", "benign"], ["benign", "benign"],
    ["lb", "likely_benign"], ["likely benign", "likely_benign"],
    ["vus", "uncertain_significance"], ["uncertain significance", "uncertain_significance"],
    ["lp", "likely_pathogenic"], ["likely pathogenic", "likely_pathogenic"],
    ["p", "pathogenic"], ["pathogenic", "pathogenic"],
  ]).get(key);
  if (!normalized) throw new PublishedAcmgBenchmarkInputError(`unsupported ACMG classification '${raw}'`);
  return { raw, normalized, normalizationNotes: repaired === raw ? [] : [`source_typo:${raw}`] };
}

function normalizeSourceClassification(value: WorkbookCell | undefined): NormalizedSourceClassification {
  const raw = cellText(value);
  if (raw.toLowerCase() === "conflicting classifications of pathogenicity") {
    return { raw, normalized: "conflicting_classifications", normalizationNotes: [] };
  }
  const normalized = normalizeClassification(value);
  return { raw: normalized.raw, normalized: normalized.normalized, normalizationNotes: normalized.normalizationNotes };
}

function modelAssessment(args: {
  rowId: string;
  actor: "deepseek_r1" | "o3_mini_high";
  criteria: WorkbookCell | undefined;
  classification: WorkbookCell | undefined;
  reportedConcordance: WorkbookCell | undefined;
  reference: NormalizedClassification;
  mismatches: PublishedAcmgBenchmarkBundle["quality"]["reportedConcordanceMismatches"];
}): ModelClassificationAssessment {
  const classification = normalizeClassification(args.classification);
  const reportedConcordant = parseYesNo(`${args.rowId} ${args.actor} concordance`, args.reportedConcordance);
  const computedConcordant = classification.normalized === args.reference.normalized;
  if (reportedConcordant !== computedConcordant) {
    args.mismatches.push({ rowId: args.rowId, actor: args.actor, reportedConcordant, computedConcordant });
  }
  return {
    criteriaRaw: cellText(args.criteria),
    criteria: parseAcmgCriteria(args.criteria),
    classification,
    reportedConcordant,
    computedConcordant,
    concordanceConsistent: reportedConcordant === computedConcordant,
  };
}

function ruleRows(sheet: PublishedAcmgWorkbookSheet, headers: string[]): RuleDevelopmentRow[] {
  const family = RULE_SHEET_FAMILIES.get(sheet.sheet);
  if (!family) throw new PublishedAcmgBenchmarkInputError(`no criterion family for sheet '${sheet.sheet}'`);
  const out: RuleDevelopmentRow[] = [];
  sheet.data.slice(2).forEach((row, index) => {
    if (!cellText(row[0])) return;
    const sourceRow = index + 3;
    const rowId = `${sheet.sheet}:${sourceRow}`;
    const application = cellText(row[1]).toLowerCase();
    const expectedApplication = application === "rule-positive" ? "rule_positive"
      : application === "rule-negative" ? "rule_negative"
        : null;
    if (!expectedApplication) throw new PublishedAcmgBenchmarkInputError(`${rowId} has unsupported rule application '${cellText(row[1])}'`);
    const variantText = cellText(row[0]);
    out.push({
      rowId,
      datasetRole: "rule_development",
      sheet: sheet.sheet,
      sourceRow,
      criterionFamily: family,
      variantText,
      identity: unresolvedIdentity(variantText),
      expectedApplication,
      expectedCriterion: expectedApplication === "rule_positive" ? parseAcmgCriterionToken(cellText(row[2])) : null,
      publicationPmids: parsePmids(row[3]),
      modelConcordance: {
        deepseekR1: parseYesNo(`${rowId} DeepSeek-R1 concordance`, row[4]),
        o3MiniHigh: parseYesNo(`${rowId} o3-mini-high concordance`, row[5]),
      },
      rawCells: rawCells(headers, row),
    });
  });
  return out;
}

function knowledgeRows(sheet: PublishedAcmgWorkbookSheet, headers: string[]): AuthoredKnowledgeRow[] {
  const topic = KNOWLEDGE_TOPICS.get(sheet.sheet);
  if (!topic) throw new PublishedAcmgBenchmarkInputError(`no knowledge topic for sheet '${sheet.sheet}'`);
  const out: AuthoredKnowledgeRow[] = [];
  sheet.data.slice(2).forEach((row, index) => {
    if (!rowHasValue(row)) return;
    const sourceRow = index + 3;
    const populated = row.filter((value) => value !== null && cellText(value) !== "").length;
    out.push({
      rowId: `${sheet.sheet}:${sourceRow}`,
      datasetRole: "authored_knowledge",
      sheet: sheet.sheet,
      sourceRow,
      topic,
      rowKind: populated === 1 ? "note" : "entry",
      fields: rawCells(headers, row),
    });
  });
  return out;
}

function classificationRows(
  sheet: PublishedAcmgWorkbookSheet,
  headers: string[],
  role: "external_validation" | "external_reanalysis",
  sourceNotes: WorkbookSourceNote[],
  mismatches: PublishedAcmgBenchmarkBundle["quality"]["reportedConcordanceMismatches"],
): ClassificationBenchmarkRow[] {
  const out: ClassificationBenchmarkRow[] = [];
  sheet.data.slice(2).forEach((row, index) => {
    const sourceRow = index + 3;
    const variantText = cellText(row[1]);
    if (!variantText) {
      const note = cellText(row[0]);
      if (note) sourceNotes.push({ sheet: sheet.sheet, sourceRow, text: note });
      return;
    }
    const rowId = `${sheet.sheet}:${sourceRow}`;
    const validation = role === "external_validation";
    const independentIndex = validation ? 3 : 4;
    const humanCriteriaIndex = validation ? 4 : 5;
    const referenceIndex = validation ? 5 : 7;
    const deepseekCriteriaIndex = validation ? 6 : 8;
    const deepseekClassIndex = validation ? 7 : 9;
    const deepseekMatchIndex = validation ? 8 : 10;
    const o3CriteriaIndex = validation ? 9 : 11;
    const o3ClassIndex = validation ? 10 : 12;
    const o3MatchIndex = validation ? 11 : 13;
    const reference = normalizeClassification(row[referenceIndex]);
    const deepseekR1 = modelAssessment({
      rowId, actor: "deepseek_r1", criteria: row[deepseekCriteriaIndex], classification: row[deepseekClassIndex],
      reportedConcordance: row[deepseekMatchIndex], reference, mismatches,
    });
    const o3MiniHigh = modelAssessment({
      rowId, actor: "o3_mini_high", criteria: row[o3CriteriaIndex], classification: row[o3ClassIndex],
      reportedConcordance: row[o3MatchIndex], reference, mismatches,
    });
    const independentCriteria = parseAcmgCriteria(row[independentIndex]);
    const humanCriteria = parseAcmgCriteria(row[humanCriteriaIndex]);
    const allCriteria = [...independentCriteria, ...humanCriteria, ...deepseekR1.criteria, ...o3MiniHigh.criteria];
    const publicationCountValue = validation ? undefined : Number(row[6]);
    if (!validation && (!Number.isSafeInteger(publicationCountValue) || publicationCountValue! < 0)) {
      throw new PublishedAcmgBenchmarkInputError(`${rowId} has an invalid publication count`);
    }
    out.push({
      rowId,
      datasetRole: role,
      sheet: sheet.sheet,
      sourceRow,
      genes: cellText(row[0]).split(",").map((gene) => gene.trim()).filter(Boolean),
      variantText,
      identity: unresolvedIdentity(variantText),
      sourceClassification: normalizeSourceClassification(row[2]),
      literatureIndependentCriteriaRaw: cellText(row[independentIndex]),
      literatureIndependentCriteria: independentCriteria,
      humanCriteriaRaw: cellText(row[humanCriteriaIndex]),
      humanCriteria,
      referenceClassification: reference,
      ...(validation ? {} : { sourceSubmissionSummary: cellText(row[3]), publicationCount: publicationCountValue }),
      modelAssessments: { deepseekR1, o3MiniHigh },
      unparsedCriterionCount: allCriteria.filter((criterion) => criterion.parseStatus === "unparsed").length,
      rawCells: rawCells(headers, row),
    });
  });
  return out;
}

function sheetInputs(sheets: Sheet[]): PublishedAcmgWorkbookSheet[] {
  return sheets.map((sheet) => ({
    sheet: sheet.sheet,
    data: sheet.data.map((row) => row.map(normalizeCell)),
  }));
}

export async function readPublishedAcmgWorkbook(bytes: Buffer | Uint8Array): Promise<PublishedAcmgWorkbookSheet[]> {
  const workbook = Buffer.from(bytes);
  if (workbook.length === 0) throw new PublishedAcmgBenchmarkInputError("workbookBytes must not be empty");
  try {
    return sheetInputs(await readXlsxFile(workbook, { trim: false }));
  } catch (error) {
    throw new PublishedAcmgBenchmarkInputError(`could not read XLSX workbook: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function buildPublishedAcmgBenchmarkBundle(args: {
  datasetId: string;
  version: string;
  sourceUri: string;
  citation: string;
  workbookDigest: `sha256:${string}`;
  containerDigest?: `sha256:${string}`;
  sheets: readonly PublishedAcmgWorkbookSheet[];
  enforcePublishedCounts?: boolean;
}): PublishedAcmgBenchmarkBundle {
  const datasetId = assertDatasetId("datasetId", args.datasetId);
  const version = assertDatasetId("version", args.version);
  const sourceUri = assertText("sourceUri", args.sourceUri);
  const citation = assertText("citation", args.citation);
  const workbookDigest = assertDigest("workbookDigest", args.workbookDigest);
  const containerDigest = args.containerDigest === undefined ? undefined : assertDigest("containerDigest", args.containerDigest);
  const enforcePublishedCounts = args.enforcePublishedCounts ?? true;
  const actualNames = args.sheets.map((sheet) => sheet.sheet);
  const expectedNames = [...SHEET_SPECS.keys()];
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new PublishedAcmgBenchmarkInputError("workbook sheets do not match the published S1-S13 order and names");
  }

  const ruleDevelopmentRows: RuleDevelopmentRow[] = [];
  const authoredKnowledgeRows: AuthoredKnowledgeRow[] = [];
  const classificationBenchmarkRows: ClassificationBenchmarkRow[] = [];
  const sourceNotes: WorkbookSourceNote[] = [];
  const reportedConcordanceMismatches: PublishedAcmgBenchmarkBundle["quality"]["reportedConcordanceMismatches"] = [];
  const sheetInventory: PublishedAcmgBenchmarkBundle["sheets"] = [];

  for (const sheet of args.sheets) {
    const spec = SHEET_SPECS.get(sheet.sheet)!;
    const headers = headersFor(sheet, spec);
    let rowCount: number;
    if (spec.role === "rule_development") {
      const rows = ruleRows(sheet, headers);
      ruleDevelopmentRows.push(...rows);
      rowCount = rows.length;
    } else if (spec.role === "authored_knowledge") {
      const rows = knowledgeRows(sheet, headers);
      authoredKnowledgeRows.push(...rows);
      rowCount = rows.length;
    } else {
      const rows = classificationRows(sheet, headers, spec.role, sourceNotes, reportedConcordanceMismatches);
      classificationBenchmarkRows.push(...rows);
      rowCount = rows.length;
    }
    if (enforcePublishedCounts && rowCount !== spec.expectedRows) {
      throw new PublishedAcmgBenchmarkInputError(`sheet '${sheet.sheet}' has ${rowCount} data rows; expected ${spec.expectedRows}`);
    }
    sheetInventory.push({
      name: sheet.sheet,
      title: cellText(sheet.data[0]?.[0]),
      datasetRole: spec.role,
      rowCount,
    });
  }

  const allCriteria = [
    ...ruleDevelopmentRows.flatMap((row) => row.expectedCriterion ? [{ rowId: row.rowId, criterion: row.expectedCriterion }] : []),
    ...classificationBenchmarkRows.flatMap((row) => [
      ...row.literatureIndependentCriteria,
      ...row.humanCriteria,
      ...row.modelAssessments.deepseekR1.criteria,
      ...row.modelAssessments.o3MiniHigh.criteria,
    ].map((criterion) => ({ rowId: row.rowId, criterion }))),
  ];
  const roleCounts: Record<PublishedAcmgDatasetRole, number> = {
    rule_development: ruleDevelopmentRows.length,
    authored_knowledge: authoredKnowledgeRows.length,
    external_validation: classificationBenchmarkRows.filter((row) => row.datasetRole === "external_validation").length,
    external_reanalysis: classificationBenchmarkRows.filter((row) => row.datasetRole === "external_reanalysis").length,
  };
  return {
    schema: PUBLISHED_ACMG_BENCHMARK_SCHEMA,
    datasetId,
    version,
    source: { uri: sourceUri, citation, workbookDigest, ...(containerDigest ? { containerDigest } : {}) },
    adapter: {
      id: "pi-bio-workbench.published-acmg-workbook",
      version: "0.1.0",
      libraries: {
        workbook: "read-excel-file@9.3.1",
        container: "fflate@0.8.3",
      },
      contractDigest: ADAPTER_CONTRACT_DIGEST,
    },
    sheets: sheetInventory,
    ruleDevelopmentRows,
    authoredKnowledgeRows,
    classificationRows: classificationBenchmarkRows,
    sourceNotes,
    quality: {
      roleCounts,
      unresolvedVariantIdentities: ruleDevelopmentRows.length + classificationBenchmarkRows.length,
      unparsedCriterionTokens: allCriteria
        .filter(({ criterion }) => criterion.parseStatus === "unparsed")
        .map(({ rowId, criterion }) => ({ rowId, raw: criterion.raw })),
      reportedConcordanceMismatches,
    },
  };
}

function validationManifest(): BioManifest {
  return {
    schema: "pi-bio.manifest.v1",
    id: "published-acmg-benchmark-validation",
    version: "0.1.0",
    title: "Published ACMG workbook validation",
    description: "Validate dataset-role boundaries and source quality signals over one content-pinned workbook bundle.",
    provides: {
      resolvers: [{
        id: "duckdb.sql_materialize",
        version: "0.1.0",
        title: "DuckDB SQL materialization",
        description: "Materialize protected normalized benchmark rows as a bounded relation.",
        output: { mode: "table" },
      }],
      resources: [{
        id: "benchmark_rows",
        title: "Normalized published ACMG benchmark rows",
        kind: "virtual",
        resolver: "duckdb.sql_materialize",
        params: {
          table: "benchmark_rows",
          sql: `WITH bundle AS (
  SELECT CAST(getvariable('benchmark_bundle_json') AS JSON) AS document
), rows AS (
  SELECT
    'rule_development' AS dataset_role,
    json_extract_string(item.value, '$.rowId') AS row_id,
    json_extract_string(item.value, '$.identity.status') AS identity_status,
    0::INTEGER AS concordance_mismatch_count,
    CASE WHEN json_extract_string(item.value, '$.expectedCriterion.parseStatus') = 'unparsed' THEN 1 ELSE 0 END AS unparsed_criterion_count
  FROM bundle, json_each(json_extract(document, '$.ruleDevelopmentRows')) AS item
  UNION ALL
  SELECT
    'authored_knowledge',
    json_extract_string(item.value, '$.rowId'),
    NULL::VARCHAR,
    0::INTEGER,
    0::INTEGER
  FROM bundle, json_each(json_extract(document, '$.authoredKnowledgeRows')) AS item
  UNION ALL
  SELECT
    json_extract_string(item.value, '$.datasetRole'),
    json_extract_string(item.value, '$.rowId'),
    json_extract_string(item.value, '$.identity.status'),
    (CASE WHEN try_cast(json_extract(item.value, '$.modelAssessments.deepseekR1.concordanceConsistent') AS BOOLEAN) = false THEN 1 ELSE 0 END
      + CASE WHEN try_cast(json_extract(item.value, '$.modelAssessments.o3MiniHigh.concordanceConsistent') AS BOOLEAN) = false THEN 1 ELSE 0 END)::INTEGER,
    try_cast(json_extract(item.value, '$.unparsedCriterionCount') AS INTEGER)
  FROM bundle, json_each(json_extract(document, '$.classificationRows')) AS item
)
SELECT * FROM rows`,
        },
      }],
      operations: [{
        id: "benchmark.validate_import",
        version: "0.1.0",
        title: "Validate published ACMG workbook import",
        description: "Count each role and surface unresolved identities, criterion parse failures, and source concordance disagreements.",
        transport: "duckdb.sql",
        inputSchema: { type: "object" },
        sql: {
          readOnly: true,
          requiredResources: ["benchmark_rows"],
          sqlTemplate: `SELECT
  dataset_role,
  count(*)::INTEGER AS row_count,
  count(*) FILTER (WHERE identity_status = 'unresolved')::INTEGER AS unresolved_identity_count,
  coalesce(sum(concordance_mismatch_count), 0)::INTEGER AS concordance_mismatch_count,
  coalesce(sum(unparsed_criterion_count), 0)::INTEGER AS unparsed_criterion_count
FROM benchmark_rows
GROUP BY dataset_role
ORDER BY CASE dataset_role
  WHEN 'rule_development' THEN 1
  WHEN 'authored_knowledge' THEN 2
  WHEN 'external_validation' THEN 3
  WHEN 'external_reanalysis' THEN 4
  ELSE 5 END`,
        },
      }],
    },
  };
}

function registrationNode(datasetId: string, version: string): string {
  return `benchmark:${datasetId}@${version}`;
}

function registrationStatementKey(datasetId: string, version: string): string {
  return `published-acmg-benchmark:${datasetId}:${version}`;
}

function registrationFromValue(
  valueJson: string,
  recordedAt: string,
  observationDigest: string | null,
): PublishedAcmgBenchmarkRegistration {
  const value = JSON.parse(valueJson) as Record<string, unknown>;
  if (value.schema !== PUBLISHED_ACMG_BENCHMARK_REGISTRATION_SCHEMA) throw new Error("published ACMG benchmark ledger value has an invalid schema");
  const registrationDigest = assertDigest("registrationDigest", observationDigest);
  if (canonicalDigest(value) !== registrationDigest) {
    throw new Error("published ACMG benchmark ledger value does not match its observation digest");
  }
  return {
    schema: PUBLISHED_ACMG_BENCHMARK_REGISTRATION_SCHEMA,
    datasetId: assertDatasetId("datasetId", value.datasetId),
    version: assertDatasetId("version", value.version),
    sourceUri: assertText("sourceUri", value.sourceUri),
    citation: assertText("citation", value.citation),
    rawDigest: assertDigest("rawDigest", value.rawDigest),
    rawUri: `cas:${assertDigest("rawDigest", value.rawDigest)}`,
    ...(value.containerDigest === undefined ? {} : {
      containerDigest: assertDigest("containerDigest", value.containerDigest),
      containerUri: `cas:${assertDigest("containerDigest", value.containerDigest)}` as `cas:sha256:${string}`,
    }),
    normalizedDigest: assertDigest("normalizedDigest", value.normalizedDigest),
    normalizedUri: `cas:${assertDigest("normalizedDigest", value.normalizedDigest)}`,
    adapterContractDigest: assertDigest("adapterContractDigest", value.adapterContractDigest),
    roleCounts: assertRoleCounts(value.roleCounts),
    validationRunId: assertText("validationRunId", value.validationRunId),
    validationCasRefs: assertRunCasRefs(value.validationCasRefs),
    registrationDigest,
    recordedAt,
  };
}

async function readRegistration(
  conn: SqlConn,
  datasetId: string,
  version: string,
  asOf = AS_OF,
): Promise<PublishedAcmgBenchmarkRegistration | null> {
  const observation = await observationAsOfKey(conn, registrationStatementKey(datasetId, version), asOf);
  if (!observation?.value_json) return null;
  const registration = registrationFromValue(observation.value_json, observation.recorded_at, observation.digest);
  if (registration.datasetId !== datasetId || registration.version !== version) throw new Error("published ACMG benchmark ledger identity mismatch");
  return registration;
}

function validationRows(rows: Array<Record<string, unknown>>, bundle: PublishedAcmgBenchmarkBundle): void {
  const byRole = new Map(rows.map((row) => [String(row.dataset_role), row]));
  for (const [role, count] of Object.entries(bundle.quality.roleCounts)) {
    const row = byRole.get(role);
    if (!row || Number(row.row_count) !== count) {
      throw new Error(`recorded benchmark validation did not reproduce the '${role}' row count`);
    }
  }
  const mismatchCount = rows.reduce((sum, row) => sum + Number(row.concordance_mismatch_count ?? 0), 0);
  if (mismatchCount !== bundle.quality.reportedConcordanceMismatches.length) {
    throw new Error("recorded benchmark validation did not reproduce the concordance mismatch count");
  }
  const unparsedCount = rows.reduce((sum, row) => sum + Number(row.unparsed_criterion_count ?? 0), 0);
  if (unparsedCount !== bundle.quality.unparsedCriterionTokens.length) {
    throw new Error("recorded benchmark validation did not reproduce the unparsed criterion count");
  }
}

export async function registerPublishedAcmgWorkbook(
  workspace: string,
  request: RegisterPublishedAcmgWorkbookRequest,
): Promise<{ registration: PublishedAcmgBenchmarkRegistration; bundle: PublishedAcmgBenchmarkBundle; validationRows: Array<Record<string, unknown>> }> {
  const datasetId = assertDatasetId("datasetId", request.datasetId);
  const version = assertDatasetId("version", request.version);
  const sourceUri = assertText("sourceUri", request.sourceUri);
  const citation = assertText("citation", request.citation);
  const expectedWorkbookDigest = assertDigest("expectedWorkbookDigest", request.expectedWorkbookDigest);
  const workbookBytes = Buffer.from(request.workbookBytes);
  if (workbookBytes.length === 0) throw new PublishedAcmgBenchmarkInputError("workbookBytes must be non-empty");
  const rawDigest = sha256(workbookBytes);
  if (rawDigest !== expectedWorkbookDigest) {
    throw new PublishedAcmgBenchmarkInputError(`workbook digest mismatch: expected ${expectedWorkbookDigest}, received ${rawDigest}`);
  }
  const sourceContainer = request.sourceContainer === undefined ? undefined : {
    bytes: Buffer.from(request.sourceContainer.bytes),
    expectedDigest: assertDigest("sourceContainer.expectedDigest", request.sourceContainer.expectedDigest),
    mediaType: assertMediaType("sourceContainer.mediaType", request.sourceContainer.mediaType),
  };
  if (sourceContainer?.bytes.length === 0) throw new PublishedAcmgBenchmarkInputError("sourceContainer.bytes must be non-empty");
  const containerDigest = sourceContainer === undefined ? undefined : sha256(sourceContainer.bytes);
  if (sourceContainer && containerDigest !== sourceContainer.expectedDigest) {
    throw new PublishedAcmgBenchmarkInputError(`source container digest mismatch: expected ${sourceContainer.expectedDigest}, received ${containerDigest}`);
  }
  const recordedAt = assertTimestamp("recordedAt", request.recordedAt ?? new Date().toISOString());
  const sheets = await readPublishedAcmgWorkbook(workbookBytes);
  const bundle = buildPublishedAcmgBenchmarkBundle({
    datasetId,
    version,
    sourceUri,
    citation,
    workbookDigest: rawDigest,
    ...(containerDigest ? { containerDigest } : {}),
    sheets,
    enforcePublishedCounts: request.enforcePublishedCounts,
  });
  const normalizedBytes = canonicalJsonBytes(bundle as unknown as JsonValue);
  const normalizedDigest = sha256(normalizedBytes);
  const validationRunId = request.validationRunId ?? `benchmark-${datasetId}-${version}-validate`;
  if (validationRunId.length > 127 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(validationRunId)) {
    throw new PublishedAcmgBenchmarkInputError("validationRunId must be a valid run id of at most 127 characters");
  }

  const store = await openBioStore(workspace);
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  try {
    const existing = await readRegistration(store.conn, datasetId, version);
    if (existing) {
      if (existing.rawDigest !== rawDigest || existing.normalizedDigest !== normalizedDigest || existing.containerDigest !== containerDigest) {
        throw new PublishedAcmgBenchmarkInputError(`benchmark '${datasetId}@${version}' already exists with different immutable content`);
      }
      return { registration: existing, bundle, validationRows: [] };
    }

    const rawArtifact = await putCas(cas, workbookBytes, WORKBOOK_MEDIA_TYPE);
    const containerArtifact = sourceContainer === undefined ? undefined : await putCas(cas, sourceContainer.bytes, sourceContainer.mediaType);
    const normalizedArtifact = await putCas(cas, normalizedBytes, BUNDLE_MEDIA_TYPE);
    const validation = await runBioOperationFromManifest({
      cwd: workspace,
      dbPath: ":memory:",
      manifestSnapshot: validationManifest(),
      manifestBaseDir: workspace,
      operationId: "benchmark.validate_import",
      runId: validationRunId,
      now: recordedAt,
      protectedSessionBindings: { benchmark_bundle_json: normalizedBytes.toString("utf8") },
      protectedSessionVariables: ["benchmark_bundle_json"],
      cas,
      store: store.conn,
      casMetadata: { conn: store.conn },
      author: SOURCE,
    });
    if (!validation.ok) throw new Error(`published ACMG benchmark validation failed: ${validation.error}`);
    const rows = validation.result.rows as Array<Record<string, unknown>>;
    validationRows(rows, bundle);
    const validationCasRefs = assertRunCasRefs(validation.casRefs);
    const registrationBody = {
      schema: PUBLISHED_ACMG_BENCHMARK_REGISTRATION_SCHEMA,
      datasetId,
      version,
      sourceUri,
      citation,
      rawDigest: rawArtifact.digest,
      ...(containerArtifact ? { containerDigest: containerArtifact.digest } : {}),
      normalizedDigest: normalizedArtifact.digest,
      adapterContractDigest: bundle.adapter.contractDigest,
      roleCounts: bundle.quality.roleCounts,
      validationRunId,
      validationCasRefs,
    };
    const registrationDigest = canonicalDigest(registrationBody);
    const registration: PublishedAcmgBenchmarkRegistration = {
      ...registrationBody,
      rawUri: rawArtifact.uri,
      ...(containerArtifact ? { containerUri: containerArtifact.uri } : {}),
      normalizedUri: normalizedArtifact.uri,
      registrationDigest,
      recordedAt,
    };
    let persistedRegistration = registration;
    let wroteRegistration = true;
    await inTransaction(store.conn, async () => {
      const concurrent = await readRegistration(store.conn, datasetId, version);
      if (concurrent) {
        if (concurrent.rawDigest !== rawDigest || concurrent.normalizedDigest !== normalizedDigest || concurrent.containerDigest !== containerDigest) {
          throw new PublishedAcmgBenchmarkInputError(`benchmark '${datasetId}@${version}' already exists with different immutable content`);
        }
        persistedRegistration = concurrent;
        wroteRegistration = false;
        return;
      }
      const node = registrationNode(datasetId, version);
      await recordObservation(store.conn, {
        statementKey: registrationStatementKey(datasetId, version),
        subjectId: node,
        predicate: "published_acmg_benchmark",
        value: registrationBody,
        recordedAt,
        source: SOURCE,
        digest: registrationDigest,
      });
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: rawArtifact.digest,
          mediaType: WORKBOOK_MEDIA_TYPE,
          semanticRole: "benchmark_source_workbook",
          sizeBytes: rawArtifact.sizeBytes,
          attrs: { dataset_id: datasetId, version, source_uri: sourceUri },
        },
        subjectId: node,
        predicate: "uses_source",
        recordedAt,
        source: SOURCE,
        digest: registrationDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "benchmark_source_workbook" },
      });
      if (containerArtifact && sourceContainer) {
        await recordArtifactReference(store.conn, {
          artifact: {
            digest: containerArtifact.digest,
            mediaType: sourceContainer.mediaType,
            semanticRole: "benchmark_source_archive",
            sizeBytes: containerArtifact.sizeBytes,
            attrs: { dataset_id: datasetId, version, source_uri: sourceUri },
          },
          subjectId: node,
          predicate: "uses_source",
          recordedAt,
          source: SOURCE,
          digest: registrationDigest,
          casMetadata: { conn: store.conn, refId: node, refType: "benchmark_source_archive" },
        });
      }
      await recordArtifactReference(store.conn, {
        artifact: {
          digest: normalizedArtifact.digest,
          mediaType: BUNDLE_MEDIA_TYPE,
          semanticRole: "normalized_benchmark_bundle",
          sizeBytes: normalizedArtifact.sizeBytes,
          attrs: { dataset_id: datasetId, version, adapter_contract_digest: bundle.adapter.contractDigest },
        },
        subjectId: node,
        predicate: "produces",
        recordedAt,
        source: SOURCE,
        digest: registrationDigest,
        casMetadata: { conn: store.conn, refId: node, refType: "normalized_benchmark_bundle" },
      });
      await recordObservationLink(store.conn, {
        subjectId: node,
        predicate: "validated_by",
        objectId: `run:${validationRunId}`,
        recordedAt,
        source: SOURCE,
        digest: registrationDigest,
      });
      await recordObservationLink(store.conn, {
        subjectId: `run:${validationRunId}`,
        predicate: "uses_source",
        objectId: normalizedArtifact.uri,
        recordedAt,
        source: SOURCE,
        digest: normalizedArtifact.digest,
      });
    });
    return { registration: persistedRegistration, bundle, validationRows: wroteRegistration ? rows : [] };
  } finally {
    store.close();
  }
}

export async function registerPublishedAcmgWorkbookFile(
  workspace: string,
  request: RegisterPublishedAcmgWorkbookFileRequest,
): ReturnType<typeof registerPublishedAcmgWorkbook> {
  const { workbookPath, ...registrationRequest } = request;
  const workbookBytes = await fs.readFile(workbookPath);
  return registerPublishedAcmgWorkbook(workspace, { ...registrationRequest, workbookBytes });
}

export async function registerPublishedAcmgWorkbookArchiveFile(
  workspace: string,
  request: RegisterPublishedAcmgWorkbookArchiveFileRequest,
): ReturnType<typeof registerPublishedAcmgWorkbook> {
  const { archivePath, expectedArchiveDigest: requestedArchiveDigest, ...registrationRequest } = request;
  const archiveBytes = await fs.readFile(archivePath);
  if (archiveBytes.length === 0) throw new PublishedAcmgBenchmarkInputError("source ZIP archive must be non-empty");
  const expectedArchiveDigest = assertDigest("expectedArchiveDigest", requestedArchiveDigest);
  const archiveDigest = sha256(archiveBytes);
  if (archiveDigest !== expectedArchiveDigest) {
    throw new PublishedAcmgBenchmarkInputError(`source archive digest mismatch: expected ${expectedArchiveDigest}, received ${archiveDigest}`);
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archiveBytes);
  } catch (error) {
    throw new PublishedAcmgBenchmarkInputError(`could not read source ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const workbooks = Object.entries(entries).filter(([name]) => !name.endsWith("/") && name.toLowerCase().endsWith(".xlsx"));
  if (workbooks.length !== 1) {
    throw new PublishedAcmgBenchmarkInputError(`source ZIP archive must contain exactly one XLSX workbook; found ${workbooks.length}`);
  }
  const workbookBytes = workbooks[0]![1];
  return registerPublishedAcmgWorkbook(workspace, {
    ...registrationRequest,
    workbookBytes,
    sourceContainer: {
      bytes: archiveBytes,
      expectedDigest: expectedArchiveDigest,
      mediaType: "application/zip",
    },
  });
}

export async function getPublishedAcmgBenchmarkRegistration(
  workspace: string,
  datasetId: string,
  version: string,
  asOf = AS_OF,
): Promise<PublishedAcmgBenchmarkRegistration | null> {
  const store = await openBioStore(workspace);
  try {
    return await readRegistration(store.conn, assertDatasetId("datasetId", datasetId), assertDatasetId("version", version), asOf);
  } finally {
    store.close();
  }
}

export async function getPublishedAcmgBenchmarkBundle(
  workspace: string,
  datasetId: string,
  version: string,
  asOf = AS_OF,
): Promise<{ registration: PublishedAcmgBenchmarkRegistration; bundle: PublishedAcmgBenchmarkBundle } | null> {
  const registration = await getPublishedAcmgBenchmarkRegistration(workspace, datasetId, version, asOf);
  if (!registration) return null;
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const bytes = await fs.readFile(cas.pathFor(casAddress(registration.normalizedDigest)));
  const digest = sha256(bytes);
  if (digest !== registration.normalizedDigest) {
    throw new Error(`published ACMG benchmark CAS digest mismatch: expected ${registration.normalizedDigest}, received ${digest}`);
  }
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("published ACMG benchmark bundle is not a JSON object");
  }
  const bundle = value as PublishedAcmgBenchmarkBundle;
  const bundleRoleCounts = assertRoleCounts(bundle.quality?.roleCounts);
  if (bundle.schema !== PUBLISHED_ACMG_BENCHMARK_SCHEMA
    || bundle.datasetId !== registration.datasetId
    || bundle.version !== registration.version
    || bundle.source?.uri !== registration.sourceUri
    || bundle.source?.citation !== registration.citation
    || bundle.source?.workbookDigest !== registration.rawDigest
    || bundle.source?.containerDigest !== registration.containerDigest
    || bundle.adapter?.contractDigest !== registration.adapterContractDigest
    || DATASET_ROLES.some((role) => bundleRoleCounts[role] !== registration.roleCounts[role])
    || !Array.isArray(bundle.ruleDevelopmentRows)
    || !Array.isArray(bundle.authoredKnowledgeRows)
    || !Array.isArray(bundle.classificationRows)) {
    throw new Error("published ACMG benchmark bundle does not match its ledger registration");
  }
  return { registration, bundle };
}
