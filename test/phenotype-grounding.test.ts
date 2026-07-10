import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, openBioStore } from "pi-bio-agent";
import {
  narrativeDigest,
  runPhenotypeGrounding,
  sqlPhenotypeCandidateRetriever,
  type GroundingAgentPort,
  type GroundingAugmenterPort,
  type GroundingReviewerPort,
  type PhenotypeTermProposal,
} from "../src/phenotype-grounding.js";
import { groundingMetrics, runPhenotypeGroundingBenchmark } from "../src/phenotype-benchmark.js";
import { loadHostGroundingRuntime } from "../src/grounding-host.js";

async function ontologyStore() {
  const dir = await fs.mkdtemp(join(tmpdir(), "grounding-test-"));
  const store = await openBioStore(dir, { path: join(dir, "grounding.duckdb") });
  await store.conn.run(`CREATE TABLE hpo_terms (
    hpo_id VARCHAR, label VARCHAR, synonym VARCHAR, ontology_source VARCHAR, ontology_version VARCHAR, ontology_digest VARCHAR
  )`);
  for (const row of [
    ["HP:0001252", "Hypotonia", "Low muscle tone"],
    ["HP:0001251", "Ataxia", "Unsteady gait"],
    ["HP:0001250", "Seizure", "Seizures"],
  ]) await store.conn.run("INSERT INTO hpo_terms VALUES (?, ?, ?, 'HPO', '2026-fixture', 'sha256:ontology')", row);
  return store;
}

function proposal(text: string, chosen: string, evidence: string, context: PhenotypeTermProposal["assertionContext"] = "present", subject: PhenotypeTermProposal["subjectContext"] = "proband", subjectId?: string): PhenotypeTermProposal {
  const startOffset = text.indexOf(evidence);
  return {
    proposalId: `${chosen}:${context}:${subject}:${subjectId ?? ""}`, chosen, confidence: 1,
    assertionContext: context, subjectContext: subject, ...(subjectId ? { subjectId } : {}),
    evidenceText: evidence, startOffset, endOffset: startOffset + evidence.length,
    rationale: "test proposal",
  };
}

const reviewer: GroundingReviewerPort = {
  identity: { id: "fixture-reviewer", version: "1" },
  async review(input) {
    assert.ok(!("gold" in input));
    return input.proposals.map(({ proposalId, proposalDigest }) => ({
      proposalId,
      proposalDigest,
      inputDigest: input.inputDigest,
      decision: "approved",
      rationale: "fixture approval",
      reviewer: "fixture-reviewer",
    }));
  },
};

const augmenter: GroundingAugmenterPort = {
  identity: { id: "fixture-augmenter", version: "1", provider: "fixture", model: "augmentation-v1" },
  async augment(input) {
    assert.ok(!("gold" in input), "gold must never enter augmenter input");
    return {
      phase: input.phase, retrievalText: "ataxia", retrievalPhrases: ["ataxia"], provider: "fixture",
      model: "augmentation-v1", inputDigest: canonicalDigest(input), rationale: "retrieve a clinical candidate",
    };
  },
};

function candidateAgent(text: string): GroundingAgentPort {
  return {
    identity: { id: "fixture-agent", version: "1", provider: "fixture", model: "deterministic" },
    async propose(input) {
      assert.ok(!("gold" in input), "gold must never enter agent input");
      const ids = new Set(input.candidates.map((candidate) => candidate.id));
      return [
        ...(ids.has("HP:0001252") ? [proposal(text, "HP:0001252", "hypotonia")] : []),
        ...(ids.has("HP:0001251") ? [proposal(text, "HP:0001251", "poor coordination")] : []),
      ];
    },
  };
}

const text = "The child has hypotonia and poor coordination.";

for (const mode of ["none", "pre-retrieval", "post-initial-retrieval", "pre+post"] as const) {
  test(`grounding mode ${mode} is runnable and keeps augmentation separate`, async () => {
    const store = await ontologyStore();
    try {
      const result = await runPhenotypeGrounding({
        retriever: sqlPhenotypeCandidateRetriever(store.conn),
        narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) }, mode,
        agent: candidateAgent(text), reviewer, ...(mode === "none" ? {} : { augmenter }),
      });
      assert.equal(result.augmentations.length, mode === "pre+post" ? 2 : mode === "none" ? 0 : 1);
      assert.equal(result.accepted.some((item) => item.hpoId === "HP:0001251"), mode !== "none");
      assert.ok(result.accepted.every((item) => text.slice(item.startOffset, item.endOffset) === item.evidenceText));
    } finally { store.close(); }
  });
}

test("augmentation cannot serve as evidence and invented CURIEs are rejected", async () => {
  const store = await ontologyStore();
  try {
    const malformed = await runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn), narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) },
      mode: "pre-retrieval", augmenter, reviewer,
      agent: { ...candidateAgent(text), propose: async () => [{ ...proposal("ataxia", "HP:0001251", "ataxia"), startOffset: 0, endOffset: 6 }] },
    });
    assert.equal(malformed.accepted.length, 0);
    assert.match(malformed.rejected[0]?.reason ?? "", /original narrative|evidence span/);

    const invented = await runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn), narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) },
      mode: "none", reviewer, agent: { ...candidateAgent(text), propose: async () => [proposal(text, "HP:9999999", "hypotonia")] },
    });
    assert.equal(invented.accepted.length, 0);
    assert.match(invented.rejected[0]?.reason ?? "", /no invented identifiers/);
  } finally { store.close(); }
});

test("negative, uncertain, differential, and family contexts are retained", async () => {
  const store = await ontologyStore();
  const narrative = "The proband has hypotonia. Mother has no seizures. Ataxia is uncertain and seizure is in the differential.";
  try {
    const result = await runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn), narrative: { caseId: "C2", text: narrative, sourceDigest: narrativeDigest(narrative) }, mode: "none", reviewer,
      agent: { ...candidateAgent(narrative), propose: async () => [
        proposal(narrative, "HP:0001252", "hypotonia", "present"),
        proposal(narrative, "HP:0001250", "seizures", "absent", "family", "mother"),
        proposal(narrative, "HP:0001251", "Ataxia", "uncertain"),
        proposal(narrative, "HP:0001250", "seizure", "differential"),
      ] },
    });
    assert.deepEqual(new Set(result.accepted.map((item) => item.assertionContext)), new Set(["present", "absent", "uncertain", "differential"]));
    assert.equal(result.accepted.find((item) => item.assertionContext === "absent")?.subjectId, "mother");
  } finally { store.close(); }
});

test("contradictory duplicates are rejected before review", async () => {
  const store = await ontologyStore();
  try {
    const result = await runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn), narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) }, mode: "none", reviewer,
      agent: { ...candidateAgent(text), propose: async () => [proposal(text, "HP:0001252", "hypotonia"), { ...proposal(text, "HP:0001252", "hypotonia", "absent"), proposalId: "contradiction" }] },
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.filter(({ reason }) => reason.includes("contradictory")).length, 2);
  } finally { store.close(); }
});

test("review decisions bind the exact proposal/input and use a distinct reviewer identity", async () => {
  const store = await ontologyStore();
  try {
    const agent = candidateAgent(text);
    await assert.rejects(() => runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn),
      narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) },
      mode: "none",
      agent,
      reviewer: { ...reviewer, identity: agent.identity },
    }), /distinct port identities/);

    await assert.rejects(() => runPhenotypeGrounding({
      retriever: sqlPhenotypeCandidateRetriever(store.conn),
      narrative: { caseId: "C1", text, sourceDigest: narrativeDigest(text) },
      mode: "none",
      agent,
      reviewer: {
        identity: { id: "tampered-reviewer", version: "1" },
        review: async (input) => input.proposals.map(({ proposalId }) => ({
          proposalId,
          proposalDigest: "sha256:tampered",
          inputDigest: input.inputDigest,
          decision: "approved",
          rationale: "tampered",
          reviewer: "tampered-reviewer",
        })),
      },
    }), /does not bind the proposal/);
  } finally { store.close(); }
});

test("a packaged host can inject a grounding runtime module", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "grounding-host-"));
  const modulePath = join(dir, "host.mjs");
  await fs.writeFile(modulePath, `export default ({ workspace }) => ({
    mode: "none",
    contractDigest: "sha256:host-contract",
    agent: { identity: { id: "host-agent", version: "1" }, propose: async () => [] },
    reviewer: { identity: { id: "host-reviewer", version: "1" }, review: async () => [] },
    workspace
  });\n`);
  const runtime = await loadHostGroundingRuntime(dir, modulePath);
  assert.equal(runtime.agent.identity.id, "host-agent");
  assert.equal(runtime.reviewer.identity.id, "host-reviewer");
});

test("benchmark reports per-case and micro metrics without passing gold to ports", async () => {
  const store = await ontologyStore();
  try {
    const report = await runPhenotypeGroundingBenchmark({
      conn: store.conn, modes: ["none", "pre-retrieval"], agent: candidateAgent(text), reviewer, augmenter,
      generatedAt: "2026-07-10T00:00:00Z",
      suite: {
        suite: "hermetic-grounding",
        source: "fixture",
        version: "1",
        cases: [{
          caseId: "C1",
          narrative: text,
          goldAssertions: [
            { hpoId: "HP:0001252", assertionContext: "present", subjectContext: "proband", evidenceText: "hypotonia", startOffset: text.indexOf("hypotonia"), endOffset: text.indexOf("hypotonia") + "hypotonia".length },
            { hpoId: "HP:0001251", assertionContext: "present", subjectContext: "proband", evidenceText: "poor coordination", startOffset: text.indexOf("poor coordination"), endOffset: text.indexOf("poor coordination") + "poor coordination".length },
          ],
        }],
      },
    });
    assert.equal(report.predictions.find((run) => run.mode === "none")?.metrics.recall, 0.5);
    assert.equal(report.predictions.find((run) => run.mode === "pre-retrieval")?.metrics.f1, 1);
    assert.equal(report.aggregate["pre-retrieval"].recall, 1);
    assert.deepEqual(groundingMetrics(["A", "B"], ["A", "C"]), { truePositive: 1, falsePositive: 1, falseNegative: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
  } finally { store.close(); }
});
