import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBioRegistry, type BioManifest } from "../src/core/manifest.js";
import { JudgeContractError, decideGrounding, runGroundingJudgment, type BioJudgeImpl } from "../src/core/judgment.js";

// The typed judgment boundary, derived from metacurator's "disambiguate may return only one of the provided
// grounded CURIEs or None". Candidates are a registered TermSet (data); the model is injected; core decides.

const candidates: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "disease-grounding",
  version: "0.1.0",
  title: "Disease grounding candidates",
  description: "MONDO candidates for grounding free-text disease labels.",
  provides: {
    termSets: [{ id: "mondo.candidates", title: "MONDO candidates", members: [
      { id: "MONDO:0005180", label: "Parkinson disease" },
      { id: "MONDO:0004975", label: "Alzheimer disease" },
      { id: "MONDO:0007739", label: "Huntington disease" },
    ] }],
  },
};

function registry() {
  const r = createBioRegistry();
  r.registerManifest(candidates);
  return r;
}
const judgeReturning = (proposal: Awaited<ReturnType<BioJudgeImpl>>): BioJudgeImpl => async () => proposal;
const run = (r: ReturnType<typeof createBioRegistry>, judge: BioJudgeImpl, minConfidence?: number) =>
  runGroundingJudgment(r, { termSetId: "mondo.candidates", question: "Parkinson's disease", minConfidence, now: "2026-06-28T00:00:00Z" }, judge);

describe("typed judgment: ground free text to a registered candidate term set", () => {
  test("a valid candidate choice grounds to the exact TermRef", async () => {
    const j = await run(registry(), judgeReturning({ chosen: "MONDO:0005180", evidence: "title mentions Parkinson", confidence: 0.9 }));
    assert.equal(j.status, "grounded");
    assert.deepEqual(j.chosen, { id: "MONDO:0005180", label: "Parkinson disease" });
    assert.equal(j.evidence, "title mentions Parkinson");
    assert.equal(j.candidatesConsidered, 3);
  });

  test("null abstains — the model is allowed to not choose", async () => {
    const j = await run(registry(), judgeReturning({ chosen: null, evidence: "ambiguous" }));
    assert.equal(j.status, "abstained");
    assert.equal(j.chosen, null);
  });

  test("an invented identifier is rejected (no minting)", async () => {
    await assert.rejects(() => run(registry(), judgeReturning({ chosen: "MONDO:9999999" })), JudgeContractError);
    // same rule at the pure decision layer
    assert.throws(() => decideGrounding({ chosen: "NOT:0001" }, candidates.provides.termSets![0]!), /no invented identifiers/);
  });

  test("a below-threshold confidence abstains rather than grounds", async () => {
    const j = await run(registry(), judgeReturning({ chosen: "MONDO:0005180", confidence: 0.3 }), 0.5);
    assert.equal(j.status, "abstained");
    assert.equal(j.chosen, null);
  });

  test("fails closed on an unregistered term set", async () => {
    await assert.rejects(
      () => runGroundingJudgment(registry(), { termSetId: "ghost", question: "x", now: "t" }, judgeReturning({ chosen: null })),
      /no term set 'ghost'/,
    );
  });

  test("rejects a malformed proposal (non-string chosen, out-of-range confidence)", async () => {
    const ts = candidates.provides.termSets![0]!;
    assert.throws(() => decideGrounding({ chosen: 42 as unknown as string }, ts), /must be a candidate id string or null/);
    assert.throws(() => decideGrounding({ chosen: null, confidence: 1.5 }, ts), /confidence.*\[0, 1\]/);
    assert.throws(() => decideGrounding({ chosen: null, confidence: Number.NaN }, ts), /confidence.*\[0, 1\]/);
  });

  test("the judgment is deterministic for a fixed proposal", async () => {
    const judge = judgeReturning({ chosen: "MONDO:0004975", confidence: 0.8 });
    assert.deepEqual(await run(registry(), judge), await run(registry(), judge));
  });
});
