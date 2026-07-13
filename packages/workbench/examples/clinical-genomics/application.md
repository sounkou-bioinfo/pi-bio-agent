# Clinical genomics evidence application


This is an executable downstream application of `pi-bio-agent`, not a
proposed core workflow. It composes the workbench’s declared relations
into two traversal lanes over one case:

- **direct** starts from observed variants and retains candidates,
  abstentions, and evidence conflicts;
- **inverted** grounds the case narrative, walks phenotype/disease/gene
  relations, resolves assembly-pinned intervals, reads only those
  indexed VCF regions, and annotates selected alleles.

Both lanes materialize into `case_evidence`. The application owns
phenotype policy, coverage semantics, ranking, review items, and the
evidence packet. Core supplies manifest execution, DuckDB
materialization, bounded HTTP fanout, checkpoints, CAS, replay, and
observations.

## Hermetic host composition

The executable document uses recorded grounding, a local Monarch-shaped
fixture, an indexed VCF fixture, and a local VEP-compatible HTTP server.
The server deliberately returns two `503` responses before succeeding,
exercising the generic DuckNNG fanout/retry path without relying on a
live endpoint.

``` ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClinicalReviewQueue,
  listClinicalAnalyses,
  listClinicalReanalysisQueue,
  runClinicalGenomicsWorkbench,
  updateClinicalReviewDisposition,
} from "../../dist/clinical-genomics.js";
import { localCandidateVariantSearchRuntime } from "../../dist/candidate-variant-search.js";
import { localMonarchFixtureRuntime } from "../../dist/monarch-host.js";
import { loadRecordedGroundingRuntime } from "../../dist/recorded-grounding.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-clinical-application-"));
await fs.cp(sourceDir, workspace, {
  recursive: true,
  filter: (source) => relative(sourceDir, source).split(sep)[0] !== ".pi",
});

const annotations = {
  "17-43093464-A-T": { gene: "GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.0002, significance: "pathogenic" },
  "17-43093470-C-G": { gene: "GENEB", consequence: "missense_variant", impact: "MODERATE", af: 0.0003, significance: "uncertain_significance" },
  "17-43093470-C-T": { gene: "GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.02, significance: "benign" },
};

let requests = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  requests += 1;
  if (request.method !== "POST" || request.url !== "/vep") {
    response.writeHead(404).end();
    return;
  }
  if (requests <= 2) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "transient_fixture_failure" }));
    return;
  }
  const variants = JSON.parse(Buffer.concat(chunks).toString("utf8")).variants;
  const rows = variants.map((input) => {
    const [chrom, pos, _dot, ref, alt] = input.split(" ");
    const key = `${chrom}-${pos}-${ref}-${alt}`;
    const item = annotations[key];
    return {
      input,
      most_severe_consequence: item.consequence,
      transcript_consequences: [{ gene_symbol: item.gene, impact: item.impact, consequence_terms: [item.consequence] }],
      colocated_variants: [{ id: key, clin_sig: [item.significance], frequencies: { [alt]: { gnomadg: item.af } } }],
    };
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(rows));
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address !== "string");

const runtime = {
  url: `http://127.0.0.1:${address.port}/vep`,
  headersJson: '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]',
  sourceId: "fixture:vep",
  sourceVersion: "fixture-1",
  duckdbInitSql: ["LOAD ducknng"],
};

const run = async (now) => runClinicalGenomicsWorkbench({
  exampleDir: workspace,
  caseId: "CASE-RD-001",
  analysisId: "application-proof",
  now,
  grounding: await loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json")),
  hypotheses: localMonarchFixtureRuntime(workspace),
  variantSearch: localCandidateVariantSearchRuntime(workspace),
  vep: runtime,
});
```

## Execute and resume

``` ts
let first;
let resumed;
try {
  first = await run("2026-07-12T12:00:00Z");
  resumed = await run("2026-07-12T12:05:00Z");
} finally {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

assert.equal(first.workflow.executedSteps, 8);
assert.equal(first.workflow.reusedSteps, 0);
assert.equal(resumed.workflow.executedSteps, 0);
assert.equal(resumed.workflow.reusedSteps, 8);
assert.equal(resumed.packetDigest, first.packetDigest);
assert.equal(requests, 3, "resume must reuse the VEP checkpoint");

assert.equal(first.packet.summary.directCandidates, 1);
assert.equal(first.packet.summary.directAbstentions, 1);
assert.equal(first.packet.summary.resolvedCandidateGenes, 2);
assert.equal(first.packet.summary.selectedAlleles, 3);
assert.equal(first.packet.summary.invertedSupportedHypotheses, 1);
assert.equal(first.packet.summary.invertedGaps, 1);
assert.equal(first.packet.summary.conflicts, 2);

const direct = first.packet.lanes.direct.rows;
assert.equal(direct.find((row) => row.variant_key === "2-47637258-C-CT")?.variant_bucket, "abstain_no_frequency");
const inverted = first.packet.lanes.inverted.rows;
assert.equal(
  inverted.find((row) => row.gene === "GENEB" && row.evidence_status === "genotype_supports_hypothesis")?.vep_consequence,
  "stop_gained",
);

const initialReviews = await getClinicalReviewQueue(workspace, first.analysisId);
assert.equal(initialReviews.found, true);
if (!initialReviews.found) throw new Error("expected a recorded review queue");
const frequencyReview = initialReviews.reviews.find((item) => item.kind === "resolve_frequency");
assert.ok(frequencyReview);
await updateClinicalReviewDisposition(workspace, first.analysisId, {
  reviewId: frequencyReview.reviewId,
  status: "needs_follow_up",
  note: "Obtain a declared frequency source.",
  now: "2026-07-12T12:10:00Z",
});

const history = await listClinicalAnalyses(workspace, { caseId: first.packet.caseId });
assert.deepEqual(history.map((item) => item.analysisId), [first.analysisId]);
const latestCases = await listClinicalReanalysisQueue(workspace);
assert.equal(latestCases.length, 1);
assert.equal(latestCases[0]?.analysisId, first.analysisId);
assert.equal(latestCases[0]?.state, "needs_follow_up");
assert.equal(latestCases[0]?.needsFollowUpItems, 1);

piBio.json({
  application: "clinical-genomics",
  workflow: {
    first: { executedSteps: first.workflow.executedSteps, reusedSteps: first.workflow.reusedSteps },
    resumed: { executedSteps: resumed.workflow.executedSteps, reusedSteps: resumed.workflow.reusedSteps },
    replayDigestStableWithinAnalysis: resumed.workflow.replayDigest === first.workflow.replayDigest,
    packetDigestStable: resumed.packetDigest === first.packetDigest,
    vepRequestsIncludingRetries: requests,
  },
  evidence: first.packet.summary,
  provenance: {
    runCount: first.packet.provenance.runIds.length,
    packetStoredInCas: first.packetUri.startsWith("cas:sha256:"),
  },
  reviewProjection: {
    recordedAnalysesForCase: history.length,
    latestCaseState: latestCases[0]?.state,
    needsFollowUpItems: latestCases[0]?.needsFollowUpItems,
  },
});
```

<details class="pi-bio-output">

<summary>

JSON output: cell-2
</summary>

``` json
{
  "application": "clinical-genomics",
  "workflow": {
    "first": {
      "executedSteps": 8,
      "reusedSteps": 0
    },
    "resumed": {
      "executedSteps": 0,
      "reusedSteps": 8
    },
    "replayDigestStableWithinAnalysis": true,
    "packetDigestStable": true,
    "vepRequestsIncludingRetries": 3
  },
  "evidence": {
    "directCandidates": 1,
    "directAbstentions": 1,
    "phenotypeHypotheses": 2,
    "resolvedCandidateGenes": 2,
    "unresolvedCandidateGenes": 0,
    "searchedCandidateGenes": 2,
    "unsearchedCandidateGenes": 0,
    "selectedAlleles": 3,
    "invertedSupportedHypotheses": 1,
    "invertedGaps": 1,
    "invertedUnsearched": 0,
    "conflicts": 2,
    "reanalysisSignals": 1,
    "reviewQueue": [
      {
        "kind": "confirm_candidate",
        "target": "variant:17-43093464-A-T",
        "reason": "17-43093464-A-T passed the declared variant screen and has curated pathogenicity evidence; confirmation remains review-bound."
      },
      {
        "kind": "review_conflict",
        "target": "variant:3-300-C-T",
        "reason": "3-300-C-T has conflicting curated and predicted consequence evidence."
      },
      {
        "kind": "resolve_frequency",
        "target": "variant:2-47637258-C-CT",
        "reason": "2-47637258-C-CT has no usable allele frequency and was not called rare."
      },
      {
        "kind": "correlate_supported_hypothesis",
        "target": "hypothesis:MONDO:GENEB:GENEB",
        "reason": "GENEB has both phenotype and screened genotype support; their case-level fit requires review."
      },
      {
        "kind": "review_missing_genotype_support",
        "target": "hypothesis:MONDO:GENEH:GENEH",
        "reason": "GENEH is phenotype-supported, but no supporting variant was found within the recorded search scope; this is missing genotype support, not evidence against the hypothesis."
      },
      {
        "kind": "review_conflict",
        "target": "hypothesis:MONDO:GENEB:GENEB",
        "reason": "17-43093470-C-T has conflicting curated and predicted consequence evidence."
      },
      {
        "kind": "reanalysis_signal",
        "target": "variant:17-43093464-A-T",
        "reason": "17-43093464-A-T is upgraded relative to the prior assessment."
      }
    ],
    "kernelScope": "evidence routing only; not a complete clinical classification kernel"
  },
  "provenance": {
    "runCount": 9,
    "packetStoredInCas": true
  },
  "reviewProjection": {
    "recordedAnalysesForCase": 1,
    "latestCaseState": "needs_follow_up",
    "needsFollowUpItems": 1
  }
}
```

</details>

## Review state and case reanalysis projection

The evidence packet is immutable after it is committed. A reviewer
records a disposition as a separate temporal ledger observation keyed to
one packet review item; that disposition does not revise a variant
assessment or move to a later analysis automatically. The browser’s
reanalysis pane projects the latest recorded analysis for each case and
orders explicit states such as follow-up, reanalysis signal, conflict,
evidence gap, and open review. It is a transparent work queue, not a
diagnostic ranking or clinical classification.

## What the application establishes

The run establishes that the public substrate can support an application
with grounded inputs, foreign-graph queries, indexed range reads,
bounded network retry, SQL reconciliation, eight durable checkpoints, a
CAS-backed packet, and exact resume. It also preserves an important
abstention: missing population frequency is not evidence that a variant
is rare.

It does not establish ACMG/AMP classification, diagnosis, clinical
validity, or live-source stability. Those are application evaluation and
review concerns.

## Benchmark contract

Two evaluation levels must remain separate:

1.  **ACMG evidence and class concordance.** [Ma et
    al.](https://doi.org/10.1126/scitranslmed.adz4172) describe 150
    ClinGen expert-panel variants in Supplementary Table 12 and 150
    ClinVar VUS/conflicting variants in Supplementary Table 13. The
    supplied workbook also contains Hong Kong Genome Project (HKGP)
    rule-development examples in S1-S7 and authored knowledge/threshold
    tables in S8-S11; those are not held-out validation rows.
    `benchmark:acmg` imports the exact archive, CAS-pins the
    ZIP/XLSX/normalized bundle, preserves raw labels and criterion
    annotations, recomputes concordance, and records a SQL validation
    run. A fresh sample of three-star ClinVar rows is useful
    differential testing, but it is not the published benchmark.

    Here `rule_development` means that the 1,000 curator-reviewed HKGP
    variants were used to optimize the AI-CURA prompt/evidence-reading
    procedure for seven literature-dependent criteria; they did not
    develop the ACMG/AMP rules. Variant publications were retrieved
    externally and reformatted as the evidence corpus. S8-S10 instead
    provide narrow criterion guidance for PS2/PM6, PP1, and PP4, while
    S11 provides PS4 thresholds. These inputs should not be collapsed
    into one undifferentiated literature RAG corpus. The rows are real
    variants, but they are development-contaminated rather than an
    independent evaluation set.

2.  **Retrospective reanalysis yield.** The OpenAI/Boston Children’s
    [rare-disease
    study](https://openai.com/index/diagnose-rare-childhood-diseases/)
    reports solved-case recovery and 18 confirmed diagnoses from 376
    previously unsolved cases. Those case packets are not a public
    fixture here. It is a product and study-design target:
    evidence-linked hypotheses, duplicate runs, expert adjudication,
    confirmatory testing, false-positive workload, and diagnostic yield.

The workbook is a variant-classification benchmark, not a cohort of
diagnostic cases. It has HGVS-like variant text but no stable
VCV/RCV/SCV or ClinGen allele accessions, so the importer records
unresolved identities until a release-pinned mapping step can return a
unique match, ambiguity, or no match. A separate case benchmark adapter
must accept case and truth bundles as host inputs, project them into
declared DuckDB relations, run one case or a bounded cohort through the
same checkpoint graph, and write per-case predictions plus aggregate
metrics to ledger/CAS. The current synthetic clinical application tests
substrate correctness, not model or clinical quality. It is not the
default browser product surface; the registered S12/S13 variant
workspace supplies the first real-source surface.

### Release-pinned reclassification harness

The workbench also now has a temporal ClinVar source plane for
retrospective reclassification work. Raw release bytes and a declared
normalizer are pinned in CAS; normalized assertions remain in DuckLake
at an exact release snapshot; and SQL derives the
assertion-to-variation, condition, and gene graph when needed. The
ledger holds the release identity, snapshot anchor, artifact references,
and runs rather than a duplicate of the release-scale relation.

A blinded task copies only the baseline release into an agent workspace,
passes an HMAC target commitment keyed by evaluator-only entropy plus a
declared baseline candidate policy, and runs that policy as a recorded
SQL operation. The target release, commitment secret, and source-label
delta remain evaluator-only, so task metadata cannot be matched against
candidate target metadata by simple enumeration. This is meaningful only
when the host actually enforces separate tool/filesystem boundaries; a
prompt or receipt cannot make a process blind. It tests source-label
change, not diagnostic truth or clinical validity.

The agent response is also durable evidence, not loose chat JSON. Each
ranked prediction or explicit abstention binds to the candidate run’s
manifest, replay, result, and run-object digests. The evaluator copies
that verified CAS object across the host boundary and computes per-row
source-label agreement plus coverage, change recall, and reciprocal rank
in declared SQL. Proposal bytes are protected run bindings, so replay
records their digest rather than their content.

``` ts
import { createHash as createTemporalHash } from "node:crypto";
import {
  buildClinVarTemporalIsolationReceipt,
  defaultClinVarDuckLakeConfig,
  listClinVarReleases,
  prepareClinVarTemporalTask,
  registerClinVarRelease,
  registerClinVarTemporalProposalSet,
  runClinVarTemporalCandidates,
  runClinVarTemporalProposalEvaluation,
} from "../../dist/clinvar-temporal.js";

const temporalRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-clinvar-temporal-application-"));
const temporalEvaluatorWorkspace = join(temporalRoot, "evaluator");
const temporalAgentWorkspace = join(temporalRoot, "agent");
const temporalEvaluatorLake = defaultClinVarDuckLakeConfig(temporalEvaluatorWorkspace);
const temporalAgentLake = defaultClinVarDuckLakeConfig(temporalAgentWorkspace);
const temporalDigest = (value) => `sha256:${createTemporalHash("sha256").update(value).digest("hex")}`;
const temporalParser = {
  id: "application.clinvar-normalizer",
  version: "1.0.0",
  implementationDigest: temporalDigest("application.clinvar-normalizer@1.0.0"),
};
const temporalAssertion = {
  assertionId: "VCV000111",
  temporalKey: "vcv:000111",
  recordScope: "variation_aggregate",
  variationId: "111",
  conditionId: "MONDO:0000111",
  reviewStatus: "criteria provided, single submitter",
};
const temporalBaseline = await registerClinVarRelease(temporalEvaluatorWorkspace, {
  lake: temporalEvaluatorLake,
  releaseId: "baseline-visible",
  releasedAt: "2026-01-01T00:00:00Z",
  rawSource: {
    uri: "https://example.invalid/clinvar/baseline.tsv.gz",
    format: "tsv",
    mediaType: "text/tab-separated-values",
    bytes: Buffer.from("baseline fixture"),
  },
  parser: temporalParser,
  assertions: [
    { ...temporalAssertion, clinicalSignificance: "Uncertain significance" },
    {
      ...temporalAssertion,
      assertionId: "VCV000112",
      temporalKey: "vcv:000112",
      variationId: "112",
      conditionId: "MONDO:0000112",
      clinicalSignificance: "Uncertain significance",
    },
  ],
  recordedAt: "2026-02-02T00:00:00Z",
});
const temporalTarget = await registerClinVarRelease(temporalEvaluatorWorkspace, {
  lake: temporalEvaluatorLake,
  releaseId: "target-hidden",
  releasedAt: "2026-02-01T00:00:00Z",
  rawSource: {
    uri: "https://example.invalid/clinvar/target.tsv.gz",
    format: "tsv",
    mediaType: "text/tab-separated-values",
    bytes: Buffer.from("hidden target fixture"),
  },
  parser: temporalParser,
  assertions: [
    { ...temporalAssertion, clinicalSignificance: "Likely pathogenic" },
    {
      ...temporalAssertion,
      assertionId: "VCV000112",
      temporalKey: "vcv:000112",
      variationId: "112",
      conditionId: "MONDO:0000112",
      clinicalSignificance: "Uncertain significance",
    },
  ],
  recordedAt: "2026-02-02T00:00:00Z",
});
const temporalIsolation = buildClinVarTemporalIsolationReceipt({
  mode: "host_enforced",
  agentBoundaryId: "application-agent-boundary",
  evaluatorBoundaryId: "application-evaluator-boundary",
  targetAccess: "evaluator_only",
});
const temporalTask = await prepareClinVarTemporalTask({
  evaluatorWorkspace: temporalEvaluatorWorkspace,
  agentWorkspace: temporalAgentWorkspace,
  evaluatorLake: temporalEvaluatorLake,
  agentLake: temporalAgentLake,
  baseline: temporalBaseline,
  target: temporalTarget,
  candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
  targetCommitmentSecret: Buffer.alloc(32, 23),
  isolationReceipt: temporalIsolation,
  taskId: "application-temporal-task",
  recordedAt: "2026-02-02T00:01:00Z",
});
assert.deepEqual(
  (await listClinVarReleases(temporalAgentWorkspace, temporalAgentLake)).map((release) => release.releaseId),
  [temporalBaseline.releaseId],
);
assert.equal(JSON.stringify(temporalTask.task).includes(temporalTarget.releaseId), false);

const temporalCandidates = await runClinVarTemporalCandidates(
  temporalAgentWorkspace,
  temporalAgentLake,
  temporalTask.task.taskId,
  { runId: "application-temporal-candidates", now: "2026-02-02T00:02:00Z" },
);
const temporalProposals = await registerClinVarTemporalProposalSet({
  agentWorkspace: temporalAgentWorkspace,
  agentLake: temporalAgentLake,
  taskId: temporalTask.task.taskId,
  proposalSetId: "application-temporal-proposals",
  candidateRunId: temporalCandidates.runId,
  actor: {
    id: "recorded-application-agent",
    version: "1.0.0",
    provider: "fixture",
    model: "recorded-proposals",
    contractDigest: temporalDigest("recorded-application-agent-contract@1.0.0"),
  },
  proposals: [
    {
      temporalKey: "vcv:000111",
      priorityRank: 1,
      prediction: "classification",
      predictedClinicalSignificance: "Likely pathogenic",
      confidence: 0.75,
      rationale: "Recorded baseline-only proposal for the executable application fixture.",
    },
    {
      temporalKey: "vcv:000112",
      priorityRank: 2,
      prediction: "abstain",
      rationale: "The fixture actor leaves this source-label prediction unresolved.",
    },
  ],
  recordedAt: "2026-02-02T00:03:00Z",
});
const temporalScores = await runClinVarTemporalProposalEvaluation({
  evaluatorWorkspace: temporalEvaluatorWorkspace,
  evaluatorLake: temporalEvaluatorLake,
  agentWorkspace: temporalAgentWorkspace,
  agentLake: temporalAgentLake,
  proposalSetId: temporalProposals.proposalSet.proposalSetId,
  scoreRunId: "application-temporal-scores",
  metricsRunId: "application-temporal-metrics",
  now: "2026-02-02T00:04:00Z",
});
assert.deepEqual(temporalScores.scores.rows.map((row) => row.score_status), ["correct", "abstained"]);
assert.equal(temporalScores.metrics.rows[0].coverage, 0.5);
assert.equal(temporalScores.metrics.rows[0].prediction_accuracy, 1);
assert.equal(temporalScores.metrics.rows[0].classification_accuracy, 1);
assert.equal(temporalScores.metrics.rows[0].target_change_reciprocal_rank, 1);
const temporalProposalDigestRecorded = temporalProposals.proposalSet.proposalDigest.startsWith("sha256:");
await fs.rm(temporalRoot, { recursive: true, force: true });

piBio.json({
  task: {
    id: temporalTask.task.taskId,
    target: "opaque commitment in agent boundary",
    candidateRun: temporalCandidates.runId,
  },
  proposal: {
    id: temporalProposals.proposalSet.proposalSetId,
    contentDigestRecorded: temporalProposalDigestRecorded,
    actor: temporalProposals.proposalSet.actor,
  },
  evaluator: {
    scoreRun: temporalScores.scores.runId,
    metricsRun: temporalScores.metrics.runId,
    metrics: temporalScores.metrics.rows[0],
  },
});
```

<details class="pi-bio-output">

<summary>

JSON output: cell-3
</summary>

``` json
{
  "task": {
    "id": "application-temporal-task",
    "target": "opaque commitment in agent boundary",
    "candidateRun": "application-temporal-candidates"
  },
  "proposal": {
    "id": "application-temporal-proposals",
    "contentDigestRecorded": true,
    "actor": {
      "id": "recorded-application-agent",
      "version": "1.0.0",
      "provider": "fixture",
      "model": "recorded-proposals",
      "contractDigest": "sha256:5de267523d6aaca03ed4052ca67a6a6b262ba63dfac0358af8d52b9f960e0de9"
    }
  },
  "evaluator": {
    "scoreRun": "application-temporal-scores",
    "metricsRun": "application-temporal-metrics",
    "metrics": {
      "total_candidates": 2,
      "answered_candidates": 1,
      "abstained_candidates": 1,
      "correct_predictions": 1,
      "incorrect_predictions": 0,
      "classification_predictions": 1,
      "correct_classification_predictions": 1,
      "removal_predictions": 0,
      "correct_removal_predictions": 0,
      "evaluation_missing_candidates": 0,
      "target_changes": 1,
      "correctly_predicted_changes": 1,
      "first_target_change_rank": 1,
      "first_correct_change_rank": 1,
      "coverage": 0.5,
      "prediction_accuracy": 1,
      "classification_accuracy": 1,
      "removal_accuracy": null,
      "target_change_recall": 1,
      "target_change_reciprocal_rank": 1,
      "correct_change_reciprocal_rank": 1
    }
  }
}
```

</details>

## Next case-workup closure

The same inverted lane can drive a broader one-study case workup from
host-approved VCF/TSV/CSV uploads and a case narrative: grounded HPO
assertions, phenotype/disease/gene retrieval, assembly-pinned range
restriction, bounded VEP annotation, typed ACMG evidence proposals,
phenotype reranking, literature evidence, and a gated conclusion. “One
study” means one resumable checkpoint graph, not one prompt or opaque
function.

VEP is annotation evidence, not an ACMG classifier. Population
frequency, inheritance and segregation, de novo status, functional
assays, curated assertions, phenotype fit, and reviewer judgment must
remain separately sourced; missing inputs produce abstentions rather
than inferred criteria.

## How applications change core

This application is an abstraction pressure surface. The correct
movement is:

1.  keep domain policy in its SQL relations and host composition;
2.  note repeated friction while adding another application or generic
    pattern;
3.  identify the common policy-free motion;
4.  promote only that primitive to core with tests;
5.  return this application to the public API and remove the workaround.

Bounded DuckNNG HTTP fanout followed that path. Phenotype ranking,
variant-search coverage, and clinical evidence states have not repeated
elsewhere and remain here.
