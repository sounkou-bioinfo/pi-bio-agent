import { z } from "@hono/zod-openapi";

const ClinicalRegistryIdSchema = z.string().trim()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/, "identifier must start with a letter and contain only letters, digits, '.', '_', or '-'");
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "digest must be 64 lowercase hexadecimal characters");
const Sha256AddressSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "digest must be a sha256 content address");

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
  annotated_gene: z.string().nullable(),
  consequence: z.string().nullable(),
  allele_frequency: z.number().nullable(),
  clinical_significance: z.string().nullable(),
  zygosity: z.string().nullable(),
  inheritance: z.string().nullable(),
  annotation_impact: z.string().nullable(),
  annotation_consequence: z.string().nullable(),
  annotation_allele_frequency: z.number().nullable(),
  annotation_clinical_significance: z.string().nullable(),
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

export const CandidateGeneIntervalRowSchema = z.object({
  case_id: z.string(),
  gene_id: z.string(),
  gene: z.string(),
  disease_id: z.string(),
  hypothesis_rank: z.number().int(),
  assembly: z.string(),
  chrom: z.string().nullable(),
  start_1based: z.number().int().nullable(),
  end_1based: z.number().int().nullable(),
  interval_sources: z.array(z.string()).nullable(),
  interval_versions: z.array(z.string()).nullable(),
  interval_status: z.enum(["resolved", "ambiguous_locus", "missing_gene_interval"]),
}).strict().openapi("CandidateGeneIntervalRow");

export const CandidateVariantSearchRowSchema = z.object({
  record_kind: z.enum(["coverage", "variant"]),
  case_id: z.string(),
  gene_id: z.string(),
  gene: z.string(),
  disease_ids: z.array(z.string()),
  hypothesis_rank: z.number().int(),
  assembly: z.string(),
  chrom: z.string().nullable(),
  start_1based: z.number().int().nullable(),
  end_1based: z.number().int().nullable(),
  search_status: z.enum(["completed", "ambiguous_locus", "missing_gene_interval"]),
  search_scope: z.string().nullable(),
  searched_variant_count: z.number().int().nonnegative(),
  variant_key: z.string().nullable(),
  pos: z.number().int().nullable(),
  ref: z.string().nullable(),
  alt: z.string().nullable(),
  annotated_gene: z.string().nullable(),
  consequence: z.string().nullable(),
  allele_frequency: z.number().nullable(),
  clinical_significance: z.string().nullable(),
  zygosity: z.string().nullable(),
  inheritance: z.string().nullable(),
}).strict().openapi("CandidateVariantSearchRow");

export const ReanalysisRowSchema = z.object({
  case_id: z.string(),
  variant_key: z.string(),
  prior_status: z.string().nullable(),
  current_status: z.string().nullable(),
  change_status: z.enum(["new", "dropped", "unchanged", "upgraded", "downgraded", "abstain_unknown_status"]),
}).strict().openapi("ReanalysisRow");

export const VariantAnnotationAuditRowSchema = z.object({
  audit_key: z.string(),
  registration_present: z.boolean(),
  observation_present: z.boolean(),
  registration_record_count: z.number().int().nullable(),
  observation_count: z.number().int().nonnegative(),
  coverage_count: z.number().int().nonnegative(),
  declared_transcript_count: z.number().int().nonnegative().nullable(),
  emitted_transcript_count: z.number().int().nonnegative(),
  source_snapshot_count: z.number().int().nonnegative(),
  record_kind: z.enum(["coverage", "transcript_consequence", "orphan_response"]).nullable(),
  annotation_state: z.string().nullable(),
  item_id: z.string().nullable(),
  case_id: z.string().nullable(),
  variant_id: z.string().nullable(),
  variant_key: z.string().nullable(),
  assembly: z.string().nullable(),
  chrom: z.string().nullable(),
  pos: z.number().int().nullable(),
  ref: z.string().nullable(),
  alt: z.string().nullable(),
  source_variant_key: z.string().nullable(),
  reported_assembly: z.string().nullable(),
  reported_chrom: z.string().nullable(),
  reported_start: z.number().int().nullable(),
  reported_end: z.number().int().nullable(),
  reported_allele_string: z.string().nullable(),
  input: z.string().nullable(),
  source_record_id: z.string().nullable(),
  transcript_count: z.number().int().nonnegative().nullable(),
  gene_id: z.string().nullable(),
  gene: z.string().nullable(),
  transcript_id: z.string().nullable(),
  transcript_biotype: z.string().nullable(),
  is_canonical: z.boolean().nullable(),
  mane_select: z.string().nullable(),
  consequence_terms: z.array(z.string()).nullable(),
  most_severe_consequence: z.string().nullable(),
  impact: z.string().nullable(),
  hgvsc: z.string().nullable(),
  hgvsp: z.string().nullable(),
  source_id: z.string().nullable(),
  source_version: z.string().nullable(),
  source_uri: z.string().nullable(),
  source_digest: z.string().nullable(),
  observed_at: z.string().nullable(),
  admission_state: z.string().nullable(),
  audit_status: z.enum(["complete", "incomplete", "invalid"]),
  audit_issues: z.array(z.string()),
  evidence_eligible: z.boolean(),
}).strict().openapi("VariantAnnotationAuditRow");

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
const CandidateGeneIntervalOperationSchema = operationRowsSchema("CandidateGeneIntervalOperation", CandidateGeneIntervalRowSchema);
const CandidateVariantSearchOperationSchema = operationRowsSchema("CandidateVariantSearchOperation", CandidateVariantSearchRowSchema);
const VariantAnnotationAuditOperationSchema = operationRowsSchema("VariantAnnotationAuditOperation", VariantAnnotationAuditRowSchema);
const ReanalysisOperationSchema = operationRowsSchema("ReanalysisOperation", ReanalysisRowSchema);

export const ReviewItemSchema = z.object({
  kind: z.string(),
  target: z.string(),
  reason: z.string(),
}).strict().openapi("ReviewItem");

const ReviewDispositionSchema = z.enum(["open", "acknowledged", "needs_follow_up"]);

export const ClinicalReviewQueueItemSchema = ReviewItemSchema.extend({
  reviewId: z.string().regex(/^[a-f0-9]{64}$/, "reviewId must be a sha256 hex digest"),
  status: ReviewDispositionSchema,
  note: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
}).strict().openapi("ClinicalReviewQueueItem");

export const EvidencePacketSchema = z.object({
  schema: z.literal("pi-bio.workbench.evidence_packet.v1"),
  analysisId: z.string(),
  caseId: z.string(),
  generatedAt: z.iso.datetime(),
  inputRevision: z.object({
    revisionId: ClinicalRegistryIdSchema,
    revisionDigest: Sha256AddressSchema,
    revisionUri: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/),
  }).strict().optional(),
  stages: z.object({
    hypotheses: PhenotypeHypothesisOperationSchema,
    intervals: CandidateGeneIntervalOperationSchema,
    variantSearch: CandidateVariantSearchOperationSchema,
    annotationAudit: VariantAnnotationAuditOperationSchema,
    reanalysis: ReanalysisOperationSchema,
  }).strict(),
  lanes: z.object({
    direct: CaseEvidenceOperationSchema,
    inverted: CaseEvidenceOperationSchema,
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
    resolvedCandidateGenes: z.number().int().nonnegative(),
    unresolvedCandidateGenes: z.number().int().nonnegative(),
    searchedCandidateGenes: z.number().int().nonnegative(),
    unsearchedCandidateGenes: z.number().int().nonnegative(),
    selectedAlleles: z.number().int().nonnegative(),
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

const ClinicalCaseMemberSchema = z.object({
  memberId: ClinicalRegistryIdSchema,
  role: z.string().trim().min(1).max(128).optional(),
  affectedStatus: z.enum(["affected", "unaffected", "unknown"]).default("unknown"),
  sex: z.enum(["female", "male", "unknown"]).default("unknown"),
  attributes: z.record(z.string(), z.any()).optional(),
}).strict().openapi("ClinicalCaseMember");

const ClinicalCaseRelationshipSchema = z.object({
  fromMemberId: ClinicalRegistryIdSchema,
  predicate: z.string().regex(/^[a-z][a-z0-9_]*$/),
  toMemberId: ClinicalRegistryIdSchema,
  sourceAssetId: ClinicalRegistryIdSchema.optional(),
  attributes: z.record(z.string(), z.any()).optional(),
}).strict().openapi("ClinicalCaseRelationship");

const ClinicalSampleMappingSchema = z.object({
  memberId: ClinicalRegistryIdSchema,
  sampleId: z.string().trim().min(1).max(256),
}).strict().openapi("ClinicalSampleMapping");

const ClinicalCaseAssetReferenceSchema = z.object({
  assetId: ClinicalRegistryIdSchema,
  kind: z.string().trim().min(1).max(128),
  mediaType: z.string().trim().regex(/^[^\s/]+\/[^\s/]+$/),
  digest: Sha256AddressSchema,
  format: z.string().trim().min(1).max(64).optional(),
  assembly: z.string().trim().min(1).max(64).optional(),
  memberIds: z.array(ClinicalRegistryIdSchema).default([]),
  sampleMappings: z.array(ClinicalSampleMappingSchema).default([]),
  attributes: z.record(z.string(), z.any()).optional(),
}).strict().openapi("ClinicalCaseAssetReference");

const ClinicalCaseAssetSchema = ClinicalCaseAssetReferenceSchema.extend({
  uri: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
}).strict().openapi("ClinicalCaseAsset");

export const RegisterClinicalCaseRevisionSchema = z.object({
  revisionId: ClinicalRegistryIdSchema.optional(),
  parentRevisionId: ClinicalRegistryIdSchema.optional(),
  indexMemberIds: z.array(ClinicalRegistryIdSchema).default([]),
  members: z.array(ClinicalCaseMemberSchema).min(1),
  relationships: z.array(ClinicalCaseRelationshipSchema).default([]),
  assets: z.array(ClinicalCaseAssetReferenceSchema).min(1),
}).strict().openapi("RegisterClinicalCaseRevision");

export const ClinicalCaseRevisionSchema = z.object({
  schema: z.literal("pi-bio.workbench.clinical_case_revision.v1"),
  caseId: ClinicalRegistryIdSchema,
  revisionId: ClinicalRegistryIdSchema,
  parentRevisionId: ClinicalRegistryIdSchema.optional(),
  indexMemberIds: z.array(ClinicalRegistryIdSchema),
  members: z.array(ClinicalCaseMemberSchema),
  relationships: z.array(ClinicalCaseRelationshipSchema),
  assets: z.array(ClinicalCaseAssetSchema),
}).strict().openapi("ClinicalCaseRevision");

export const ClinicalCaseRevisionSummarySchema = z.object({
  caseId: ClinicalRegistryIdSchema,
  revisionId: ClinicalRegistryIdSchema,
  parentRevisionId: ClinicalRegistryIdSchema.nullable(),
  revisionDigest: Sha256AddressSchema,
  revisionUri: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/),
  memberCount: z.number().int().positive(),
  assetCount: z.number().int().positive(),
  recordedAt: z.iso.datetime(),
}).strict().openapi("ClinicalCaseRevisionSummary");

export const ClinicalCaseRevisionListSchema = z.object({
  revisions: z.array(ClinicalCaseRevisionSummarySchema),
}).strict().openapi("ClinicalCaseRevisionList");

export const ClinicalCaseRevisionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
  asOf: z.iso.datetime().optional(),
});

export const ClinicalCasePathSchema = z.object({
  caseId: ClinicalRegistryIdSchema.openapi({ param: { name: "caseId", in: "path" } }),
});

export const ClinicalCaseRevisionPathSchema = ClinicalCasePathSchema.extend({
  revisionId: ClinicalRegistryIdSchema.openapi({ param: { name: "revisionId", in: "path" } }),
});

export const StageClinicalCaseAssetPathSchema = z.object({
  digest: Sha256HexSchema.openapi({ param: { name: "digest", in: "path" } }),
});

export const StageClinicalCaseAssetResponseSchema = z.object({
  digest: Sha256AddressSchema,
  uri: z.string().regex(/^cas:sha256:[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
}).strict().openapi("StageClinicalCaseAssetResponse");

const AnalysisIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "analysisId must be a run-safe identifier")
  .describe("Analysis ledger key. Its restricted shape is required because the same value addresses durable run checkpoints.");

export const CreateClinicalAnalysisSchema = z.object({
  caseId: ClinicalRegistryIdSchema.openapi({ example: "CASE-RD-001" }),
  caseRevisionId: ClinicalRegistryIdSchema.optional().openapi({
    description: "Immutable registered input revision. Required for registry-backed production analyses; omitted only by legacy manifest fixtures.",
  }),
  analysisId: AnalysisIdSchema.optional().openapi({
    description: "Optional existing analysis id. Reusing it resumes compatible durable checkpoints instead of starting a new analysis.",
  }),
}).strict().openapi("CreateClinicalAnalysis");

export const AnalysisPathSchema = z.object({
  analysisId: AnalysisIdSchema
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

export const ClinicalAnalysisSummarySchema = z.object({
  analysisId: z.string(),
  caseId: z.string(),
  packetDigest: z.string(),
  packetUri: z.string(),
  generatedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  reviewItems: z.number().int().nonnegative(),
  directCandidates: z.number().int().nonnegative(),
  directAbstentions: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  reanalysisSignals: z.number().int().nonnegative(),
}).strict().openapi("ClinicalAnalysisSummary");

export const ClinicalAnalysisListQuerySchema = z.object({
  caseId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ClinicalAnalysisListSchema = z.object({
  analyses: z.array(ClinicalAnalysisSummarySchema),
}).strict().openapi("ClinicalAnalysisList");

export const ClinicalReviewQueueResponseSchema = z.object({
  analysisId: z.string(),
  caseId: z.string(),
  packetDigest: z.string(),
  reviews: z.array(ClinicalReviewQueueItemSchema),
}).strict().openapi("ClinicalReviewQueueResponse");

export const UpdateClinicalReviewSchema = z.object({
  status: ReviewDispositionSchema,
  note: z.string().trim().min(1).max(4_000).optional(),
}).strict().openapi("UpdateClinicalReview");

export const ReviewPathSchema = z.object({
  analysisId: AnalysisPathSchema.shape.analysisId,
  reviewId: z.string()
    .regex(/^[a-f0-9]{64}$/, "reviewId must be a sha256 hex digest")
    .openapi({ param: { name: "reviewId", in: "path" } }),
});

const ClinicalReanalysisChangeSchema = z.object({
  variantKey: z.string(),
  priorStatus: z.string().nullable(),
  currentStatus: z.string().nullable(),
  changeStatus: z.string(),
}).strict().openapi("ClinicalReanalysisChange");

export const ClinicalReanalysisQueueEntrySchema = ClinicalAnalysisSummarySchema.extend({
  groundingId: z.string(),
  runIds: z.array(z.string()),
  state: z.enum([
    "needs_follow_up",
    "reanalysis_signal",
    "evidence_conflict",
    "evidence_gap",
    "review_pending",
    "no_active_signal",
  ]),
  reasons: z.array(z.string()),
  changes: z.array(ClinicalReanalysisChangeSchema),
  openReviewItems: z.number().int().nonnegative(),
  needsFollowUpItems: z.number().int().nonnegative(),
  evidenceGaps: z.number().int().nonnegative(),
}).strict().openapi("ClinicalReanalysisQueueEntry");

export const ClinicalReanalysisQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ClinicalReanalysisQueueSchema = z.object({
  cases: z.array(ClinicalReanalysisQueueEntrySchema),
}).strict().openapi("ClinicalReanalysisQueue");

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

export const AgentSessionPathSchema = z.object({
  sessionId: z.string().trim().min(1).max(256)
    .describe("Host session identifier. The server resolves it without accepting a filesystem path.")
    .openapi({ param: { name: "sessionId", in: "path" } }),
});

export const OpenAgentSessionSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  resumeSessionId: z.string().trim().min(1).max(256).optional(),
}).strict().openapi("OpenAgentSession");

export const SendAgentMessageSchema = z.object({
  delivery: z.enum(["prompt", "steer", "follow_up"]),
  text: z.string().trim().min(1).max(100_000),
}).strict().openapi("SendAgentMessage");

export const RenameAgentSessionSchema = z.object({
  name: z.string().trim().min(1).max(160),
}).strict().openapi("RenameAgentSession");

export const AgentEventQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1_000).optional(),
});

export const AgentTranscriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const AgentSessionSchema = z.object({
  sessionId: z.string(),
  host: z.string(),
  state: z.enum(["available", "idle", "running"]),
  name: z.string().optional(),
  model: z.object({ provider: z.string(), id: z.string() }).strict().optional(),
  thinkingLevel: z.string().optional(),
  messageCount: z.number().int().nonnegative(),
  pendingMessageCount: z.number().int().nonnegative(),
  resumable: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastError: z.string().optional(),
}).strict().openapi("AgentSession");

export const AgentSessionListSchema = z.object({
  sessions: z.array(AgentSessionSchema),
}).strict().openapi("AgentSessionList");

const JsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.any()),
  z.record(z.string(), z.any()),
]);

export const AgentActivityEventSchema = z.object({
  cursor: z.number().int().positive(),
  at: z.iso.datetime(),
  kind: z.string(),
  payload: JsonValueSchema,
}).strict().openapi("AgentActivityEvent");

export const AgentActivityPageSchema = z.object({
  sessionId: z.string(),
  events: z.array(AgentActivityEventSchema),
  nextCursor: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict().openapi("AgentActivityPage");

export const AgentTranscriptSchema = z.object({
  sessionId: z.string(),
  messages: z.array(JsonValueSchema),
  omittedCount: z.number().int().nonnegative(),
}).strict().openapi("AgentTranscript");

export const AgentCommandListSchema = z.object({
  sessionId: z.string(),
  commands: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    source: z.enum(["extension", "prompt", "skill"]),
  }).strict()),
}).strict().openapi("AgentCommandList");

export const CloseAgentSessionResponseSchema = z.object({
  closed: z.literal(true),
  sessionId: z.string(),
}).strict().openapi("CloseAgentSessionResponse");

export const ArtifactReferenceSchema = z.object({
  casUri: z.string(),
  digest: z.string(),
  mediaType: z.string(),
  semanticRole: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sourceNode: z.string(),
  relation: z.string(),
  recordedAt: z.iso.datetime(),
  producerRun: z.string().nullable(),
  attrs: z.record(z.string(), z.any()),
  contentUrl: z.string(),
}).strict().openapi("ArtifactReference");

export const ArtifactReferenceListSchema = z.object({
  artifacts: z.array(ArtifactReferenceSchema),
}).strict().openapi("ArtifactReferenceList");

export const ArtifactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ArtifactDigestPathSchema = z.object({
  digest: z.string().trim().min(1).max(128)
    .describe("A sha256 content digest validated by the substrate before CAS access.")
    .openapi({ param: { name: "digest", in: "path" } }),
});

export const WorkbenchInfoSchema = z.object({
  service: z.literal("pi-bio-workbench"),
  agentHost: z.string().nullable(),
  capabilities: z.object({
    agentSessions: z.boolean(),
    agentSteering: z.boolean(),
    agentCommands: z.boolean(),
    eventStream: z.boolean(),
  }).strict(),
  addons: z.array(z.object({
    id: z.string(),
    label: z.string(),
    order: z.number().int(),
    browserEntry: z.string(),
  }).strict()),
}).strict().openapi("WorkbenchInfo");
