import { createHash } from "node:crypto";
import { canonicalDigest, decideGrounding, JudgeContractError, type SqlConn, type TermSet } from "pi-bio-agent";

export const PHENOTYPE_GROUNDING_SCHEMA = "pi-bio.workbench.phenotype_grounding.v1" as const;
export const GROUNDING_MODES = ["none", "pre-retrieval", "post-initial-retrieval", "pre+post"] as const;

export type GroundingMode = typeof GROUNDING_MODES[number];
export type AugmentationPhase = "pre-retrieval" | "post-initial-retrieval";
export type AssertionContext = "present" | "absent" | "uncertain" | "differential";
export type SubjectContext = "proband" | "family";

export interface PortIdentity {
  id: string;
  version: string;
  provider?: string;
  model?: string;
}

export interface CaseNarrative {
  caseId: string;
  text: string;
  sourceDigest: string;
}

export interface OntologyCandidate {
  id: string;
  label: string;
  matchedTexts: string[];
  ontologySource: string;
  ontologyVersion: string;
  ontologyDigest: string;
}

export interface CandidateRetrievalInput {
  caseId: string;
  pass: number;
  documents: Array<{ source: "narrative" | AugmentationPhase; text: string }>;
}

export interface CandidateRetrievalResult {
  candidates: OntologyCandidate[];
  runId?: string;
  resultDigest?: string;
}

export interface PhenotypeCandidateRetriever {
  retrieve(input: CandidateRetrievalInput): Promise<CandidateRetrievalResult>;
}

export interface GroundingAugmentation {
  phase: AugmentationPhase;
  retrievalText: string;
  retrievalPhrases: string[];
  provider: string;
  model: string;
  inputDigest: string;
  rationale: string;
}

export interface AugmenterInput {
  caseId: string;
  sourceNarrative: string;
  sourceDigest: string;
  phase: AugmentationPhase;
  initialCandidates: ReadonlyArray<Pick<OntologyCandidate, "id" | "label">>;
}

export interface GroundingAugmenterPort {
  identity: PortIdentity;
  augment(input: AugmenterInput): Promise<GroundingAugmentation>;
}

export interface PhenotypeTermProposal {
  proposalId: string;
  chosen: string;
  confidence?: number;
  assertionContext: AssertionContext;
  subjectContext: SubjectContext;
  subjectId?: string;
  evidenceText: string;
  startOffset: number;
  endOffset: number;
  rationale: string;
}

export interface GroundingAgentInput {
  caseId: string;
  sourceNarrative: string;
  sourceDigest: string;
  candidates: readonly OntologyCandidate[];
  augmentations: readonly GroundingAugmentation[];
}

export interface GroundingAgentPort {
  identity: PortIdentity;
  propose(input: GroundingAgentInput): Promise<PhenotypeTermProposal[]>;
}

export interface GroundingReviewDecision {
  proposalId: string;
  proposalDigest: string;
  inputDigest: string;
  decision: "approved" | "rejected";
  rationale: string;
  reviewer: string;
}

export type ReviewablePhenotypeProposal = PhenotypeTermProposal & {
  candidate: Pick<OntologyCandidate, "id" | "label">;
  proposalDigest: string;
};

export interface GroundingReviewInput extends GroundingAgentInput {
  inputDigest: string;
  proposals: ReadonlyArray<ReviewablePhenotypeProposal>;
}

export interface GroundingReviewerPort {
  identity: PortIdentity;
  review(input: GroundingReviewInput): Promise<GroundingReviewDecision[]>;
}

export interface GroundingRuntime {
  mode: GroundingMode;
  agent: GroundingAgentPort;
  reviewer: GroundingReviewerPort;
  augmenter?: GroundingAugmenterPort;
  /** Digest of host-owned prompts, policies, model settings, and recorded fixtures that affect this composition. */
  contractDigest: string;
}

export interface PhenotypeObservation {
  caseId: string;
  hpoId: string;
  hpoLabel: string;
  assertionContext: AssertionContext;
  subjectContext: SubjectContext;
  subjectId?: string;
  evidenceText: string;
  startOffset: number;
  endOffset: number;
  sourceDigest: string;
  ontologySource: string;
  ontologyVersion: string;
  ontologyDigest: string;
  proposalId: string;
  proposalProvider: string;
  proposalModel: string;
  proposalRationale: string;
  confidence?: number;
  review: GroundingReviewDecision;
  acceptanceState: "accepted";
}

export interface PhenotypeGroundingResult {
  schema: typeof PHENOTYPE_GROUNDING_SCHEMA;
  caseId: string;
  sourceDigest: string;
  mode: GroundingMode;
  portIdentities: {
    agent: PortIdentity;
    reviewer: PortIdentity;
    augmenter?: PortIdentity;
  };
  retrievals: CandidateRetrievalResult[];
  candidates: OntologyCandidate[];
  augmentations: GroundingAugmentation[];
  proposals: PhenotypeTermProposal[];
  reviews: GroundingReviewDecision[];
  accepted: PhenotypeObservation[];
  rejected: Array<{ proposalId: string; reason: string }>;
  timingsMs: { augmentation: number; retrieval: number; proposal: number; review: number; total: number };
}

type OntologyRow = {
  hpo_id: string;
  label: string;
  synonym: string | null;
  ontology_source: string;
  ontology_version: string;
  ontology_digest: string;
};

export function narrativeDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** SQL-backed retrieval over a declared `hpo_terms` label/synonym relation. */
export async function retrievePhenotypeCandidates(
  conn: SqlConn,
  documents: readonly string[],
): Promise<OntologyCandidate[]> {
  const normalized = [...new Set(documents.map((text) => text.trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) return [];
  const documentRows = normalized.map(() => "(?)").join(", ");
  const rows = await conn.all<OntologyRow & { matched_text: string }>(
    `WITH documents(text) AS (VALUES ${documentRows}),
     term_text AS (
       SELECT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest, label AS matched_text
       FROM hpo_terms
       UNION ALL
       SELECT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest, synonym AS matched_text
       FROM hpo_terms
       WHERE synonym IS NOT NULL
     )
     SELECT DISTINCT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest, matched_text
     FROM term_text, documents
     WHERE strpos(text, lower(matched_text)) > 0
     ORDER BY hpo_id, matched_text`,
    normalized,
  );
  const candidates = new Map<string, OntologyCandidate>();
  for (const row of rows) {
    const existing = candidates.get(row.hpo_id);
    if (existing) {
      if (existing.label !== row.label || existing.ontologyDigest !== row.ontology_digest) {
        throw new Error(`inconsistent declared ontology rows for '${row.hpo_id}'`);
      }
      if (!existing.matchedTexts.includes(row.matched_text)) existing.matchedTexts.push(row.matched_text);
      continue;
    }
    candidates.set(row.hpo_id, {
      id: row.hpo_id,
      label: row.label,
      matchedTexts: [row.matched_text],
      ontologySource: row.ontology_source,
      ontologyVersion: row.ontology_version,
      ontologyDigest: row.ontology_digest,
    });
  }
  return [...candidates.values()];
}

export function sqlPhenotypeCandidateRetriever(conn: SqlConn): PhenotypeCandidateRetriever {
  return {
    async retrieve(input) {
      return { candidates: await retrievePhenotypeCandidates(conn, input.documents.map(({ text }) => text)) };
    },
  };
}

function validateNarrative(narrative: CaseNarrative): void {
  if (!narrative.caseId || !narrative.text) throw new Error("case narrative requires non-empty caseId and text");
  if (narrativeDigest(narrative.text) !== narrative.sourceDigest) {
    throw new Error("source narrative digest does not match immutable text");
  }
}

function validateAugmentation(
  augmentation: GroundingAugmentation,
  input: AugmenterInput,
): void {
  if (augmentation.phase !== input.phase) {
    throw new Error(`augmenter returned phase '${augmentation.phase}' for '${input.phase}' request`);
  }
  if (augmentation.inputDigest !== canonicalDigest(input)) {
    throw new Error("augmentation input digest does not match the request");
  }
  if (!augmentation.provider || !augmentation.model || !augmentation.rationale) {
    throw new Error("augmentation requires provider, model, and rationale metadata");
  }
  if (typeof augmentation.retrievalText !== "string") throw new Error("augmentation retrievalText must be a string");
  if (!Array.isArray(augmentation.retrievalPhrases)
    || augmentation.retrievalPhrases.some((phrase) => typeof phrase !== "string" || !phrase.trim())) {
    throw new Error("augmentation retrievalPhrases must contain only non-empty strings");
  }
}

function proposalShapeError(proposal: PhenotypeTermProposal, narrative: CaseNarrative): string | undefined {
  if (!proposal.proposalId || !proposal.chosen || !proposal.rationale) {
    return "missing proposal metadata";
  }
  if (!(["present", "absent", "uncertain", "differential"] as string[]).includes(proposal.assertionContext)) {
    return "invalid assertion context";
  }
  if (!(["proband", "family"] as string[]).includes(proposal.subjectContext)) return "invalid subject context";
  if (proposal.subjectContext === "family" && !proposal.subjectId) return "family proposal requires subjectId";
  if (!Number.isInteger(proposal.startOffset) || !Number.isInteger(proposal.endOffset)
    || proposal.startOffset < 0 || proposal.endOffset <= proposal.startOffset
    || proposal.endOffset > narrative.text.length) {
    return "invalid original-narrative offsets";
  }
  if (!proposal.evidenceText
    || narrative.text.slice(proposal.startOffset, proposal.endOffset) !== proposal.evidenceText) {
    return "evidence span does not match the original narrative";
  }
  return undefined;
}

function augmentationDocuments(
  narrative: CaseNarrative,
  augmentations: readonly GroundingAugmentation[],
): CandidateRetrievalInput["documents"] {
  return [
    { source: "narrative", text: narrative.text },
    ...augmentations.flatMap((augmentation) => [
      { source: augmentation.phase, text: augmentation.retrievalText },
      ...augmentation.retrievalPhrases.map((text) => ({ source: augmentation.phase, text })),
    ]),
  ];
}

export async function runPhenotypeGrounding(args: {
  narrative: CaseNarrative;
  mode: GroundingMode;
  retriever: PhenotypeCandidateRetriever;
  agent: GroundingAgentPort;
  reviewer: GroundingReviewerPort;
  augmenter?: GroundingAugmenterPort;
  minConfidence?: number;
}): Promise<PhenotypeGroundingResult> {
  const started = performance.now();
  validateNarrative(args.narrative);
  if (!GROUNDING_MODES.includes(args.mode)) throw new Error(`invalid grounding mode '${String(args.mode)}'`);
  if (args.mode !== "none" && !args.augmenter) throw new Error(`grounding mode '${args.mode}' requires an augmenter port`);
  if (args.agent.identity.id === args.reviewer.identity.id) throw new Error("grounding agent and reviewer require distinct port identities");

  const augmentations: GroundingAugmentation[] = [];
  const retrievals: CandidateRetrievalResult[] = [];
  let augmentationMs = 0;
  let retrievalMs = 0;

  const augment = async (phase: AugmentationPhase, candidates: OntologyCandidate[]): Promise<void> => {
    const input: AugmenterInput = {
      caseId: args.narrative.caseId,
      sourceNarrative: args.narrative.text,
      sourceDigest: args.narrative.sourceDigest,
      phase,
      initialCandidates: candidates.map(({ id, label }) => ({ id, label })),
    };
    const tick = performance.now();
    const value = await args.augmenter!.augment(input);
    augmentationMs += performance.now() - tick;
    validateAugmentation(value, input);
    augmentations.push(value);
  };

  if (args.mode === "pre-retrieval" || args.mode === "pre+post") await augment("pre-retrieval", []);
  let tick = performance.now();
  let retrieval = await args.retriever.retrieve({
    caseId: args.narrative.caseId,
    pass: 1,
    documents: augmentationDocuments(args.narrative, augmentations),
  });
  retrievalMs += performance.now() - tick;
  retrievals.push(retrieval);

  if (args.mode === "post-initial-retrieval" || args.mode === "pre+post") {
    await augment("post-initial-retrieval", retrieval.candidates);
    tick = performance.now();
    retrieval = await args.retriever.retrieve({
      caseId: args.narrative.caseId,
      pass: 2,
      documents: augmentationDocuments(args.narrative, augmentations),
    });
    retrievalMs += performance.now() - tick;
    retrievals.push(retrieval);
  }

  const candidates = retrieval.candidates;
  const agentInput: GroundingAgentInput = {
    caseId: args.narrative.caseId,
    sourceNarrative: args.narrative.text,
    sourceDigest: args.narrative.sourceDigest,
    candidates,
    augmentations,
  };
  tick = performance.now();
  const proposals = await args.agent.propose(agentInput);
  const proposalMs = performance.now() - tick;

  const rejected: PhenotypeGroundingResult["rejected"] = [];
  const proposalIds = new Set<string>();
  const termSet: TermSet = {
    id: `retrieved-hpo:${args.narrative.caseId}`,
    title: "Retrieved HPO candidates",
    members: candidates.map(({ id, label }) => ({ id, label })),
  };
  const reviewable: GroundingReviewInput["proposals"][number][] = [];
  for (const proposal of proposals) {
    if (proposalIds.has(proposal.proposalId)) throw new Error(`duplicate proposal id '${proposal.proposalId}'`);
    proposalIds.add(proposal.proposalId);
    const shapeError = proposalShapeError(proposal, args.narrative);
    if (shapeError) {
      rejected.push({ proposalId: proposal.proposalId, reason: shapeError });
      continue;
    }
    try {
      const decision = decideGrounding(
        { chosen: proposal.chosen, confidence: proposal.confidence, evidence: proposal.evidenceText },
        termSet,
        { minConfidence: args.minConfidence },
      );
      if (decision.status === "abstained" || !decision.chosen) {
        rejected.push({ proposalId: proposal.proposalId, reason: "confidence gate abstained" });
        continue;
      }
      const candidate = candidates.find(({ id }) => id === decision.chosen!.id)!;
      reviewable.push({
        ...proposal,
        candidate: { id: candidate.id, label: candidate.label },
        proposalDigest: canonicalDigest({ ...proposal, candidate: { id: candidate.id, label: candidate.label } }),
      });
    } catch (error) {
      if (!(error instanceof JudgeContractError)) throw error;
      rejected.push({ proposalId: proposal.proposalId, reason: error.message });
    }
  }

  const contradictory = new Set<string>();
  const seenContexts = new Map<string, { context: AssertionContext; proposalIds: string[] }>();
  for (const item of reviewable) {
    const key = `${item.candidate.id}\u0000${item.subjectContext}\u0000${item.subjectId ?? ""}`;
    const seen = seenContexts.get(key);
    if (!seen) {
      seenContexts.set(key, { context: item.assertionContext, proposalIds: [item.proposalId] });
      continue;
    }
    seen.proposalIds.push(item.proposalId);
    if (seen.context !== item.assertionContext) for (const id of seen.proposalIds) contradictory.add(id);
  }
  for (const proposalId of contradictory) rejected.push({ proposalId, reason: "contradictory assertion for the same term and subject" });
  const uniqueReviewable = reviewable.filter((item, index, all) => {
    if (contradictory.has(item.proposalId)) return false;
    const first = all.findIndex((candidate) => candidate.candidate.id === item.candidate.id
      && candidate.subjectContext === item.subjectContext
      && candidate.subjectId === item.subjectId
      && candidate.assertionContext === item.assertionContext);
    if (first === index) return true;
    rejected.push({ proposalId: item.proposalId, reason: "duplicate assertion" });
    return false;
  });

  tick = performance.now();
  const reviewInputDigest = canonicalDigest({ ...agentInput, proposals: uniqueReviewable });
  const reviews = uniqueReviewable.length
    ? await args.reviewer.review({ ...agentInput, inputDigest: reviewInputDigest, proposals: uniqueReviewable })
    : [];
  const reviewMs = performance.now() - tick;
  const reviewsByProposal = new Map<string, GroundingReviewDecision>();
  for (const review of reviews) {
    if (!review.proposalId || !review.rationale || !review.reviewer) throw new Error("review decision requires proposalId, rationale, and reviewer");
    if (review.decision !== "approved" && review.decision !== "rejected") throw new Error(`invalid review decision '${String(review.decision)}'`);
    const reviewedProposal = uniqueReviewable.find(({ proposalId }) => proposalId === review.proposalId);
    if (!reviewedProposal) throw new Error(`review references unknown proposal '${review.proposalId}'`);
    if (review.reviewer !== args.reviewer.identity.id) throw new Error(`review '${review.proposalId}' has reviewer '${review.reviewer}', expected '${args.reviewer.identity.id}'`);
    if (review.inputDigest !== reviewInputDigest) throw new Error(`review '${review.proposalId}' does not bind the review input`);
    if (review.proposalDigest !== reviewedProposal.proposalDigest) throw new Error(`review '${review.proposalId}' does not bind the proposal`);
    if (reviewsByProposal.has(review.proposalId)) throw new Error(`duplicate review for proposal '${review.proposalId}'`);
    reviewsByProposal.set(review.proposalId, review);
  }
  for (const proposal of uniqueReviewable) {
    if (!reviewsByProposal.has(proposal.proposalId)) throw new Error(`missing review for proposal '${proposal.proposalId}'`);
  }

  const accepted: PhenotypeObservation[] = [];
  for (const proposal of uniqueReviewable) {
    const review = reviewsByProposal.get(proposal.proposalId)!;
    if (review.decision === "rejected") {
      rejected.push({ proposalId: proposal.proposalId, reason: `review rejected: ${review.rationale}` });
      continue;
    }
    const candidate = candidates.find(({ id }) => id === proposal.chosen)!;
    accepted.push({
      caseId: args.narrative.caseId,
      hpoId: candidate.id,
      hpoLabel: candidate.label,
      assertionContext: proposal.assertionContext,
      subjectContext: proposal.subjectContext,
      ...(proposal.subjectId ? { subjectId: proposal.subjectId } : {}),
      evidenceText: proposal.evidenceText,
      startOffset: proposal.startOffset,
      endOffset: proposal.endOffset,
      sourceDigest: args.narrative.sourceDigest,
      ontologySource: candidate.ontologySource,
      ontologyVersion: candidate.ontologyVersion,
      ontologyDigest: candidate.ontologyDigest,
      proposalId: proposal.proposalId,
      proposalProvider: args.agent.identity.provider ?? args.agent.identity.id,
      proposalModel: args.agent.identity.model ?? args.agent.identity.version,
      proposalRationale: proposal.rationale,
      ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
      review,
      acceptanceState: "accepted",
    });
  }

  return {
    schema: PHENOTYPE_GROUNDING_SCHEMA,
    caseId: args.narrative.caseId,
    sourceDigest: args.narrative.sourceDigest,
    mode: args.mode,
    portIdentities: {
      agent: args.agent.identity,
      reviewer: args.reviewer.identity,
      ...(args.augmenter ? { augmenter: args.augmenter.identity } : {}),
    },
    retrievals,
    candidates,
    augmentations,
    proposals,
    reviews,
    accepted,
    rejected,
    timingsMs: {
      augmentation: augmentationMs,
      retrieval: retrievalMs,
      proposal: proposalMs,
      review: reviewMs,
      total: performance.now() - started,
    },
  };
}
