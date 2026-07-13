import { createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import {
  getPublishedAcmgBenchmarkBundle,
  type AcmgCriterionApplication,
  type ClassificationBenchmarkRow,
  type PublishedAcmgBenchmarkRegistration,
} from "./published-acmg-benchmark.js";
import { getPublishedVariantResolution } from "./published-variant-resolution.js";
import type { WorkbenchAddon } from "./workbench-addon.js";

const CriterionSchema = z.object({
  raw: z.string(),
  code: z.string().nullable(),
  strength: z.enum(["default", "supporting", "moderate", "strong", "very_strong"]).nullable(),
  applied: z.boolean().nullable(),
  context: z.string().optional(),
  sourceFlag: z.enum(["none", "wrong_strength", "wrong_raw_score"]),
  parseStatus: z.enum(["parsed", "unparsed"]),
}).strict();

const ClassificationSchema = z.object({
  raw: z.string(),
  normalized: z.enum(["benign", "likely_benign", "uncertain_significance", "likely_pathogenic", "pathogenic"]),
  normalizationNotes: z.array(z.string()),
}).strict();

const SourceClassificationSchema = z.object({
  raw: z.string(),
  normalized: z.enum(["benign", "likely_benign", "uncertain_significance", "likely_pathogenic", "pathogenic", "conflicting_classifications"]),
  normalizationNotes: z.array(z.string()),
}).strict();

const ModelAssessmentSchema = z.object({
  criteriaRaw: z.string(),
  criteria: z.array(CriterionSchema),
  classification: ClassificationSchema,
  reportedConcordant: z.boolean(),
  computedConcordant: z.boolean(),
  concordanceConsistent: z.boolean(),
}).strict();

const VariantSummarySchema = z.object({
  rowId: z.string(),
  datasetRole: z.enum(["external_validation", "external_reanalysis"]),
  sourceRow: z.number().int(),
  genes: z.array(z.string()),
  variantText: z.string(),
  sourceClassification: SourceClassificationSchema,
  referenceClassification: ClassificationSchema,
  literatureIndependentCriteria: z.array(CriterionSchema),
  humanCriteria: z.array(CriterionSchema),
  deepseekConcordant: z.boolean(),
  o3MiniHighConcordant: z.boolean(),
  unparsedCriterionCount: z.number().int().nonnegative(),
}).strict().openapi("PublishedVariantSummary");

const VariantDetailSchema = VariantSummarySchema.extend({
  sheet: z.string(),
  literatureIndependentCriteriaRaw: z.string(),
  humanCriteriaRaw: z.string(),
  sourceSubmissionSummary: z.string().optional(),
  publicationCount: z.number().int().nonnegative().optional(),
  modelAssessments: z.object({
    deepseekR1: ModelAssessmentSchema,
    o3MiniHigh: ModelAssessmentSchema,
  }).strict(),
}).strict().openapi("PublishedVariantDetail");

const SourceSnapshotSchema = z.object({
  sourceId: z.enum(["ncbi_variation_hgvs", "ncbi_variation_rsids", "ncbi_clinvar_search", "ncbi_clinvar_summary"]),
  uri: z.string(),
  retrievedAt: z.string(),
  mediaType: z.string(),
  digest: z.string(),
  casUri: z.string(),
  sizeBytes: z.number().int().positive(),
  runId: z.string(),
  receiptDigest: z.string(),
}).strict();

const ResolutionSchema = z.object({
  schema: z.literal("pi-bio.workbench.published_variant_resolution.v1"),
  datasetId: z.string(),
  version: z.string(),
  rowId: z.string(),
  sourceVariantText: z.string(),
  genes: z.array(z.string()),
  transcriptHgvs: z.string(),
  transcriptSpdi: z.string(),
  rsids: z.array(z.string()),
  genomicLocation: z.object({
    assembly: z.string(),
    chromosome: z.string(),
    position1Based: z.number().int().positive(),
    ref: z.string(),
    alt: z.string(),
    canonicalSpdi: z.string(),
  }).strict().nullable(),
  clinvar: z.object({
    uid: z.string(),
    accession: z.string(),
    accessionVersion: z.string(),
    title: z.string(),
    canonicalSpdi: z.string(),
    classification: z.string().nullable(),
    reviewStatus: z.string().nullable(),
    lastEvaluated: z.string().nullable(),
    traits: z.array(z.object({
      name: z.string(),
      xrefs: z.array(z.object({ source: z.string(), id: z.string() }).strict()),
    }).strict()),
  }).strict().nullable(),
  sourceSnapshots: z.array(SourceSnapshotSchema),
}).strict().openapi("PublishedVariantResolution");

const BenchmarkSchema = z.object({
  datasetId: z.string(),
  version: z.string(),
  citation: z.string(),
  sourceUri: z.string(),
  normalizedDigest: z.string(),
  recordedAt: z.string(),
  roleCounts: z.object({
    rule_development: z.number().int(),
    authored_knowledge: z.number().int(),
    external_validation: z.number().int(),
    external_reanalysis: z.number().int(),
  }).strict(),
}).strict();

const ListQuerySchema = z.object({
  role: z.enum(["external_validation", "external_reanalysis"]).optional(),
  classification: z.enum(["benign", "likely_benign", "uncertain_significance", "likely_pathogenic", "pathogenic", "conflicting_classifications"]).optional(),
  gene: z.string().max(64).optional(),
  q: z.string().max(240).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();

const RowPathSchema = z.object({ rowId: z.string().min(1).max(256) }).strict();

const VariantListSchema = z.object({
  benchmark: BenchmarkSchema,
  featuredRowId: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  rows: z.array(VariantSummarySchema),
}).strict().openapi("PublishedVariantList");

const VariantDetailResponseSchema = z.object({
  benchmark: BenchmarkSchema,
  row: VariantDetailSchema,
  resolution: ResolutionSchema.nullable(),
  resolutionUri: z.string().nullable(),
}).strict().openapi("PublishedVariantDetailResponse");

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict();

const json = <T extends z.ZodType>(schema: T) => ({ content: { "application/json": { schema } } });

const listRoute = createRoute({
  method: "get",
  path: "/v1/published-variants",
  tags: ["published variants"],
  summary: "List source-pinned published validation or reanalysis variants",
  request: { query: ListQuerySchema },
  responses: {
    200: { ...json(VariantListSchema), description: "A bounded page from the registered published workbook." },
    404: { ...json(ErrorSchema), description: "The configured published benchmark is not registered." },
    500: { ...json(ErrorSchema), description: "The published variant collection could not be read." },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/v1/published-variants/{rowId}",
  tags: ["published variants"],
  summary: "Read one published variant and its independently pinned source resolution",
  request: { params: RowPathSchema },
  responses: {
    200: { ...json(VariantDetailResponseSchema), description: "Published criterion decisions plus optional source-resolved identity." },
    404: { ...json(ErrorSchema), description: "The benchmark or row was not found." },
    500: { ...json(ErrorSchema), description: "The published variant could not be read." },
  },
});

export interface PublishedVariantsWorkbenchAddonOptions {
  workspace: string;
  datasetId?: string;
  version?: string;
  featuredRowId?: string;
}

function benchmarkView(registration: PublishedAcmgBenchmarkRegistration) {
  return {
    datasetId: registration.datasetId,
    version: registration.version,
    citation: registration.citation,
    sourceUri: registration.sourceUri,
    normalizedDigest: registration.normalizedDigest,
    recordedAt: registration.recordedAt,
    roleCounts: registration.roleCounts,
  };
}

function summary(row: ClassificationBenchmarkRow) {
  return {
    rowId: row.rowId,
    datasetRole: row.datasetRole,
    sourceRow: row.sourceRow,
    genes: row.genes,
    variantText: row.variantText,
    sourceClassification: row.sourceClassification,
    referenceClassification: row.referenceClassification,
    literatureIndependentCriteria: row.literatureIndependentCriteria,
    humanCriteria: row.humanCriteria,
    deepseekConcordant: row.modelAssessments.deepseekR1.computedConcordant,
    o3MiniHighConcordant: row.modelAssessments.o3MiniHigh.computedConcordant,
    unparsedCriterionCount: row.unparsedCriterionCount,
  };
}

function detail(row: ClassificationBenchmarkRow) {
  return {
    ...summary(row),
    sheet: row.sheet,
    literatureIndependentCriteriaRaw: row.literatureIndependentCriteriaRaw,
    humanCriteriaRaw: row.humanCriteriaRaw,
    ...(row.sourceSubmissionSummary === undefined ? {} : { sourceSubmissionSummary: row.sourceSubmissionSummary }),
    ...(row.publicationCount === undefined ? {} : { publicationCount: row.publicationCount }),
    modelAssessments: row.modelAssessments,
  };
}

function includes(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function criterionText(criteria: AcmgCriterionApplication[]): string {
  return criteria.map((item) => item.raw).join(" ");
}

export function createPublishedVariantsWorkbenchAddon(options: PublishedVariantsWorkbenchAddonOptions): WorkbenchAddon {
  const datasetId = options.datasetId ?? "ma-2025-acmg-llm";
  const version = options.version ?? "adz4172-tables-s1-s13";
  return {
    id: "published-variants",
    label: "Variants",
    order: 50,
    browserEntry: "/addons/published-variants.js",
    registerApi(app) {
      app.openapi(listRoute, async (context) => {
        try {
          const registered = await getPublishedAcmgBenchmarkBundle(options.workspace, datasetId, version);
          if (!registered) {
            return context.json({ error: { code: "benchmark_not_registered", message: `Published benchmark '${datasetId}@${version}' is not registered in this workspace.` } }, 404);
          }
          const query = context.req.valid("query");
          const role = query.role ?? "external_validation";
          const search = query.q?.trim() ?? "";
          const gene = query.gene?.trim() ?? "";
          const limit = query.limit ?? 25;
          const offset = query.offset ?? 0;
          const rows = registered.bundle.classificationRows.filter((row) => row.datasetRole === role)
            .filter((row) => !query.classification || row.sourceClassification.normalized === query.classification)
            .filter((row) => !gene || row.genes.some((item) => item.toLocaleLowerCase() === gene.toLocaleLowerCase()))
            .filter((row) => !search
              || includes(row.variantText, search)
              || row.genes.some((item) => includes(item, search))
              || includes(criterionText(row.humanCriteria), search)
              || includes(criterionText(row.literatureIndependentCriteria), search))
            .sort((left, right) => left.sourceRow - right.sourceRow);
          const featuredRowId = options.featuredRowId && registered.bundle.classificationRows.some((row) => row.rowId === options.featuredRowId)
            ? options.featuredRowId
            : null;
          return context.json(VariantListSchema.parse({
            benchmark: benchmarkView(registered.registration),
            featuredRowId,
            totalCount: rows.length,
            offset,
            limit,
            rows: rows.slice(offset, offset + limit).map(summary),
          }), 200);
        } catch (error) {
          return context.json({ error: { code: "published_variants_read_failed", message: error instanceof Error ? error.message : String(error) } }, 500);
        }
      });

      app.openapi(detailRoute, async (context) => {
        try {
          const registered = await getPublishedAcmgBenchmarkBundle(options.workspace, datasetId, version);
          if (!registered) {
            return context.json({ error: { code: "benchmark_not_registered", message: `Published benchmark '${datasetId}@${version}' is not registered in this workspace.` } }, 404);
          }
          const rowId = context.req.valid("param").rowId;
          const row = registered.bundle.classificationRows.find((item) => item.rowId === rowId);
          if (!row) return context.json({ error: { code: "variant_not_found", message: `Published variant row '${rowId}' was not found.` } }, 404);
          const resolution = await getPublishedVariantResolution(options.workspace, datasetId, version, rowId);
          return context.json(VariantDetailResponseSchema.parse({
            benchmark: benchmarkView(registered.registration),
            row: detail(row),
            resolution: resolution?.resolution ?? null,
            resolutionUri: resolution?.registration.resolutionUri ?? null,
          }), 200);
        } catch (error) {
          return context.json({ error: { code: "published_variant_read_failed", message: error instanceof Error ? error.message : String(error) } }, 500);
        }
      });
    },
  };
}
