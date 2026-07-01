import type { BioRegistry, TermRef, TermSet } from "./manifest.js";

// The typed judgment boundary (a manifest-level PATTERN, not a new registry kind). Derived from metacurator's
// determinism gradient: a model may *propose*, but the deterministic substrate decides. It validates the
// proposal against a registered candidate term set, abstains on null/low-confidence, and rejects invented
// identifiers. The model client is injected per call — the host brings its own model; core never calls one.
// This reuses the existing TermSet primitive; the only new core surface is the pure validator + its result.

/** What an injected model returns: a chosen candidate id (or null to abstain), with optional evidence. */
export interface BioJudgeProposal {
  chosen: string | null;
  evidence?: string;
  confidence?: number; // 0..1
}

export interface JudgeInput {
  question: string;
  candidates: TermRef[];
}

/** Host-supplied, model-backed judge. Injected per call; never bound into the registry. */
export type BioJudgeImpl = (input: JudgeInput) => Promise<BioJudgeProposal>;

export interface GroundingJudgment {
  schema: "pi-bio.grounding_judgment.v1";
  status: "grounded" | "abstained";
  termSetId: string;
  question: string;
  chosen: TermRef | null;
  evidence?: string;
  confidence?: number;
  candidatesConsidered: number;
  decidedAt: string;
}

/** A model proposal violated the typed-output / no-invented-identifier contract. */
export class JudgeContractError extends Error {}

/**
 * Deterministically decide a grounding from a model proposal against a candidate term set. null/undefined →
 * abstained; a candidate id → grounded with that exact TermRef; a confidence below `minConfidence` →
 * abstained; anything else (an id not among the candidates) → throws. The model cannot mint an identifier.
 */
export function decideGrounding(
  proposal: BioJudgeProposal,
  termSet: TermSet,
  opts: { minConfidence?: number } = {},
): Pick<GroundingJudgment, "status" | "chosen" | "evidence" | "confidence"> {
  if (proposal.chosen !== null && proposal.chosen !== undefined && typeof proposal.chosen !== "string") {
    throw new JudgeContractError("judge proposal 'chosen' must be a candidate id string or null");
  }
  if (proposal.confidence !== undefined && (typeof proposal.confidence !== "number" || !Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) {
    throw new JudgeContractError("judge proposal 'confidence', if present, must be a finite number in [0, 1]");
  }
  const common = { evidence: proposal.evidence, confidence: proposal.confidence };
  if (proposal.chosen === null || proposal.chosen === undefined) return { status: "abstained", chosen: null, ...common };
  const match = termSet.members.find((m) => m.id === proposal.chosen);
  if (!match) {
    throw new JudgeContractError(`grounding proposed '${proposal.chosen}', which is not a candidate in term set '${termSet.id}' (no invented identifiers)`);
  }
  if (opts.minConfidence !== undefined && (proposal.confidence ?? 0) < opts.minConfidence) {
    return { status: "abstained", chosen: null, ...common };
  }
  return { status: "grounded", chosen: match, ...common };
}

/**
 * Run a grounding judgment: pull the registered candidate term set (fail closed if missing), ask the
 * injected model to propose, then let `decideGrounding` rule. Returns the auditable judgment — the report is
 * the answer. `now` is injected for deterministic records.
 */
export async function runGroundingJudgment(
  registry: BioRegistry,
  opts: { termSetId: string; question: string; minConfidence?: number; now: string },
  judge: BioJudgeImpl,
): Promise<GroundingJudgment> {
  const termSet = registry.getTermSet(opts.termSetId);
  if (!termSet) throw new Error(`no term set '${opts.termSetId}' is registered`); // fail closed
  const proposal = await judge({ question: opts.question, candidates: termSet.members });
  const decided = decideGrounding(proposal, termSet, { minConfidence: opts.minConfidence });
  return {
    schema: "pi-bio.grounding_judgment.v1",
    status: decided.status,
    termSetId: termSet.id,
    question: opts.question,
    chosen: decided.chosen,
    evidence: decided.evidence,
    confidence: decided.confidence,
    candidatesConsidered: termSet.members.length,
    decidedAt: opts.now,
  };
}
