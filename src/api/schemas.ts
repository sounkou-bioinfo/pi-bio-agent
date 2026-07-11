import { z } from "@hono/zod-openapi";

const CasRefsSchema = z.object({
  result: z.string().optional(),
  receipts: z.string().optional(),
  replay: z.string().optional(),
  runObject: z.string().optional(),
}).strict().openapi("RunCasRefs");

const VariantBucketSchema = z.enum([
  "candidate",
  "abstain_no_frequency",
  "excluded_benign",
  "excluded_not_high_impact",
  "excluded_not_rare",
]);

const VariantStatusSchema = z.enum([
  "needs_frequency_evidence",
  "not_reportable_by_screen",
  "candidate_needs_review",
  "curated_plp_candidate",
]);

const EvidenceStatusSchema = z.union([
  VariantStatusSchema,
  z.enum([
    "hypothesis_without_supporting_variant",
    "hypothesis_not_searched",
    "genotype_supports_hypothesis",
    "hypothesis_variant_abstained",
    "variant_conflicts_with_hypothesis",
  ]),
]);

const ReviewKindSchema = z.enum([
  "confirm_candidate",
  "adjudicate_candidate",
  "resolve_frequency",
  "correlate_supported_hypothesis",
  "review_missing_genotype_support",
  "review_conflict",
]);

export const CaseEvidenceRowSchema = z.object({
  case_id: z.string(),
  lane: z.enum(["direct", "inverted"]),
  evidence_key: z.string(),
  gene_id: z.string().nullable(),
  gene: z.string(),
  disease_id: z.string().nullable(),
  disease_label: z.string().nullable(),
  variant_key: z.string().nullable(),
  consequence: z.string().nullable(),
  allele_frequency: z.number().nullable(),
  clinical_significance: z.string().nullable(),
  zygosity: z.string().nullable(),
  inheritance: z.string().nullable(),
  variant_bucket: VariantBucketSchema.nullable(),
  variant_status: VariantStatusSchema.nullable(),
  matched_observed_terms: z.number().int().nullable(),
  exact_observed_terms: z.number().int().nullable(),
  phenotype_specificity_score: z.number().nullable(),
  supporting_phenotype_annotations: z.number().int().nullable(),
  phenotype_match_kinds: z.array(z.string()).nullable(),
  phenotype_sources: z.array(z.string()).nullable(),
  has_causal_assertion: z.number().int().nullable(),
  gene_disease_assertions: z.number().int().nullable(),
  gene_disease_predicates: z.array(z.string()).nullable(),
  gene_disease_sources: z.array(z.string()).nullable(),
  hypothesis_rank: z.number().int().nullable(),
  variant_search_status: z.string().nullable(),
  variant_search_scope: z.string().nullable(),
  variant_search_assembly: z.string().nullable(),
  searched_variant_count: z.number().int().nullable(),
  evidence_status: EvidenceStatusSchema,
  missing_field: z.enum(["allele_frequency", "variant_support", "variant_search"]).nullable(),
  conflict: z.literal("benign_vs_predicted_loss_of_function").nullable(),
  review_kind: ReviewKindSchema.nullable(),
  review_target: z.string(),
}).strict().openapi("CaseEvidenceRow");

export const PhenotypeHypothesisRowSchema = z.object({
  gene_id: z.string(),
  gene: z.string(),
  disease_id: z.string(),
  disease_label: z.string(),
  matched_observed_terms: z.number().int(),
  exact_observed_terms: z.number().int(),
  phenotype_specificity_score: z.number(),
  supporting_phenotype_annotations: z.number().int(),
  phenotype_match_kinds: z.array(z.string()),
  phenotype_sources: z.array(z.string()),
  has_causal_assertion: z.number().int(),
  gene_disease_assertions: z.number().int(),
  gene_disease_predicates: z.array(z.string()),
  gene_disease_sources: z.array(z.string()),
  hypothesis_rank: z.number().int(),
}).strict().openapi("PhenotypeHypothesisRow");

export const ReanalysisRowSchema = z.object({
  case_id: z.string(),
  variant_key: z.string(),
  prior_status: z.string().nullable(),
  current_status: z.string().nullable(),
  change_status: z.enum(["new", "dropped", "unchanged", "upgraded", "downgraded", "abstain_unknown_status"]),
}).strict().openapi("ReanalysisRow");

function operationRowsSchema<T extends z.ZodType>(name: string, rows: T) {
  return z.object({
    operationId: z.string(),
    runId: z.string(),
    rows: z.array(rows),
    casRefs: CasRefsSchema.optional(),
  }).strict().openapi(name);
}

const CaseEvidenceOperationSchema = operationRowsSchema("CaseEvidenceOperation", CaseEvidenceRowSchema);
const PhenotypeHypothesisOperationSchema = operationRowsSchema("PhenotypeHypothesisOperation", PhenotypeHypothesisRowSchema);
const ReanalysisOperationSchema = operationRowsSchema("ReanalysisOperation", ReanalysisRowSchema);

export const ReviewItemSchema = z.object({
  kind: z.string(),
  target: z.string(),
  reason: z.string(),
}).strict().openapi("ReviewItem");

export const EvidencePacketSchema = z.object({
  schema: z.literal("pi-bio.workbench.evidence_packet.v1"),
  analysisId: z.string(),
  caseId: z.string(),
  generatedAt: z.iso.datetime(),
  lanes: z.object({
    hypotheses: PhenotypeHypothesisOperationSchema,
    direct: CaseEvidenceOperationSchema,
    inverted: CaseEvidenceOperationSchema,
    reanalysis: ReanalysisOperationSchema,
  }).strict(),
  grounding: z.object({
    groundingId: z.string(),
    mode: z.enum(["none", "pre-retrieval", "post-initial-retrieval", "pre+post"]),
    resultDigest: z.string(),
    resultUri: z.string(),
    sourceDigest: z.string(),
    acceptedCount: z.number().int().nonnegative(),
    rejectedCount: z.number().int().nonnegative(),
  }).strict(),
  summary: z.object({
    directCandidates: z.number().int().nonnegative(),
    directAbstentions: z.number().int().nonnegative(),
    phenotypeHypotheses: z.number().int().nonnegative(),
    invertedSupportedHypotheses: z.number().int().nonnegative(),
    invertedGaps: z.number().int().nonnegative(),
    invertedUnsearched: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    reanalysisSignals: z.number().int().nonnegative(),
    reviewQueue: z.array(ReviewItemSchema),
    kernelScope: z.string(),
  }).strict(),
  provenance: z.object({ runIds: z.array(z.string()) }).strict(),
}).strict().openapi("EvidencePacket");

export const CreateClinicalAnalysisSchema = z.object({
  caseId: z.string().trim().min(1).openapi({ example: "CASE-RD-001" }),
}).strict().openapi("CreateClinicalAnalysis");

export const AnalysisPathSchema = z.object({
  analysisId: z.string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "analysisId must be a run-safe identifier")
    .describe("Analysis ledger key. Its restricted shape is required because the same value addresses durable run checkpoints.")
    .openapi({ param: { name: "analysisId", in: "path" } }),
});

export const RunClinicalAnalysisResponseSchema = z.object({
  analysisId: z.string(),
  packet: EvidencePacketSchema,
  packetDigest: z.string(),
  packetUri: z.string(),
  workflow: z.object({
    replayDigest: z.string(),
    executedSteps: z.number().int().nonnegative(),
    reusedSteps: z.number().int().nonnegative(),
  }).strict(),
}).strict().openapi("RunClinicalAnalysisResponse");

export const ClinicalAnalysisResponseSchema = z.object({
  analysisId: z.string(),
  packet: EvidencePacketSchema,
  packetDigest: z.string(),
  packetUri: z.string(),
}).strict().openapi("ClinicalAnalysisResponse");

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("pi-bio-workbench"),
}).strict().openapi("HealthResponse");

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).strict(),
}).strict().openapi("ErrorResponse");
