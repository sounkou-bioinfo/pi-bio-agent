import { promises as fs } from "node:fs";
import { canonicalDigest } from "pi-bio-agent";
import type {
  AugmentationPhase,
  GroundingMode,
  GroundingReviewDecision,
  GroundingRuntime,
  PhenotypeTermProposal,
  PortIdentity,
} from "./phenotype-grounding.js";

type RecordedAugmentation = {
  retrievalText: string;
  retrievalPhrases: string[];
  rationale: string;
};

type RecordedProposal = PhenotypeTermProposal;
type RecordedReview = Omit<GroundingReviewDecision, "proposalDigest" | "inputDigest" | "reviewer">;

type RecordedCase = {
  augmentations: Partial<Record<AugmentationPhase, RecordedAugmentation>>;
  proposals: RecordedProposal[];
  reviews: RecordedReview[];
};

type RecordedGrounding = {
  schema: "pi-bio.workbench.recorded_grounding.v1";
  agent: PortIdentity;
  reviewer: PortIdentity;
  augmenter?: PortIdentity;
  cases: Record<string, RecordedCase>;
};

function requireIdentity(value: PortIdentity, field: string): void {
  if (!value?.id || !value.version) throw new Error(`recorded grounding '${field}' requires id and version`);
}

/** Host adapter for hermetic demos/tests. Production hosts inject live model or human ports with the same contract. */
export async function loadRecordedGroundingRuntime(
  path: string,
  mode: GroundingMode = "pre+post",
): Promise<GroundingRuntime> {
  const value = JSON.parse(await fs.readFile(path, "utf8")) as RecordedGrounding;
  if (value.schema !== "pi-bio.workbench.recorded_grounding.v1" || !value.cases) {
    throw new Error(`unsupported recorded grounding fixture '${path}'`);
  }
  requireIdentity(value.agent, "agent");
  requireIdentity(value.reviewer, "reviewer");
  if (mode !== "none") requireIdentity(value.augmenter!, "augmenter");
  return {
    mode,
    contractDigest: canonicalDigest(value),
    agent: {
      identity: value.agent,
      async propose(input) {
        const recorded = value.cases[input.caseId];
        if (!recorded) throw new Error(`no recorded grounding case '${input.caseId}'`);
        return recorded.proposals;
      },
    },
    reviewer: {
      identity: value.reviewer,
      async review(input) {
        const recorded = value.cases[input.caseId];
        if (!recorded) throw new Error(`no recorded grounding case '${input.caseId}'`);
        const reviews = new Map(recorded.reviews.map((review) => [review.proposalId, review]));
        return input.proposals.flatMap((proposal) => {
          const review = reviews.get(proposal.proposalId);
          return review ? [{
            ...review,
            proposalDigest: proposal.proposalDigest,
            inputDigest: input.inputDigest,
            reviewer: value.reviewer.id,
          }] : [];
        });
      },
    },
    ...(mode === "none" ? {} : {
      augmenter: {
        identity: value.augmenter!,
        async augment(input) {
          const recorded = value.cases[input.caseId]?.augmentations[input.phase];
          if (!recorded) throw new Error(`no recorded '${input.phase}' augmentation for case '${input.caseId}'`);
          return {
            phase: input.phase,
            ...recorded,
            provider: value.augmenter!.provider ?? value.augmenter!.id,
            model: value.augmenter!.model ?? value.augmenter!.version,
            inputDigest: canonicalDigest(input),
          };
        },
      },
    }),
  };
}
