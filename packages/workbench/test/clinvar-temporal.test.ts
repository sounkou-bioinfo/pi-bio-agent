import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { fsCasStore, materializeBioEdgesAsOf, openBioStore } from "pi-bio-agent";
import {
  ClinVarTemporalInputError,
  buildClinVarTemporalIsolationReceipt,
  defaultClinVarDuckLakeConfig,
  getClinVarTemporalProposalSet,
  getClinVarTemporalEvaluation,
  getClinVarRelease,
  getClinVarTemporalTask,
  listClinVarReleases,
  prepareClinVarTemporalTask,
  registerClinVarTemporalProposalSet,
  registerClinVarRelease,
  runClinVarAssertionGraph,
  runClinVarClassificationDelta,
  runClinVarTemporalCandidates,
  runClinVarTemporalEvaluation,
  runClinVarTemporalProposalEvaluation,
  type RegisterClinVarReleaseRequest,
} from "../src/clinvar-temporal.js";

async function workspace(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-clinvar-temporal-"));
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function commitmentSecret(): Buffer {
  return Buffer.alloc(32, 17);
}

async function mutateAgentAssertionCatalog(
  lake: ReturnType<typeof defaultClinVarDuckLakeConfig>,
  releaseId: string,
): Promise<void> {
  const instance = await DuckDBInstance.create(":memory:");
  let connection: Awaited<ReturnType<typeof instance.connect>> | undefined;
  try {
    connection = await instance.connect();
    await connection.run("LOAD ducklake");
    const catalog = `ducklake:${lake.catalogPath}`.replaceAll("'", "''");
    await connection.run(`ATTACH '${catalog}' AS clinvar_lake`);
    await connection.run(
      `UPDATE clinvar_lake.clinvar_assertions
       SET clinical_significance = 'Likely pathogenic'
       WHERE release_id = '${releaseId.replaceAll("'", "''")}' AND assertion_id = 'VCV000111'`,
    );
  } finally {
    connection?.closeSync();
    instance.closeSync();
  }
}

function releaseInput(
  lake: ReturnType<typeof defaultClinVarDuckLakeConfig>,
  releaseId: string,
  releasedAt: string,
  raw: string,
  assertions: RegisterClinVarReleaseRequest["assertions"],
): RegisterClinVarReleaseRequest {
  return {
    lake,
    releaseId,
    releasedAt,
    rawSource: {
      uri: `https://example.invalid/clinvar/${releaseId}.tsv.gz`,
      format: "tsv",
      mediaType: "text/tab-separated-values",
      bytes: Buffer.from(raw),
    },
    parser: {
      id: "test.clinvar-tsv-normalizer",
      version: "1.0.0",
      implementationDigest: digest("test.clinvar-tsv-normalizer@1.0.0"),
    },
    assertions,
  };
}

test("ClinVar releases use DuckLake snapshots for source-pinned graph and temporal comparison runs", async () => {
  const dir = await workspace();
  const lake = defaultClinVarDuckLakeConfig(dir);
  const rawBaseline = "baseline raw ClinVar bytes must remain out of the observation ledger";
  const baselineRequest = releaseInput(lake, "2026-01", "2026-01-01T00:00:00Z", rawBaseline, [
    {
      assertionId: "VCV000001",
      temporalKey: "vcv:000001",
      recordScope: "variation_aggregate",
      variationId: "1",
      conditionId: "MONDO:0000001",
      conditionLabel: "Example condition",
      geneIds: ["HGNC:1", "HGNC:2"],
      clinicalSignificance: "Uncertain significance",
      reviewStatus: "criteria provided, single submitter",
    },
    {
      assertionId: "VCV000002",
      temporalKey: "vcv:000002",
      recordScope: "variation_aggregate",
      variationId: "2",
      clinicalSignificance: "Benign",
      reviewStatus: "reviewed by expert panel",
    },
  ]);
  const baseline = await registerClinVarRelease(dir, { ...baselineRequest, recordedAt: "2026-01-02T00:00:00Z" });
  const repeated = await registerClinVarRelease(dir, { ...baselineRequest, recordedAt: "2026-01-03T00:00:00Z" });
  assert.deepEqual(repeated, baseline, "identical source content is idempotent at one release id");

  const target = await registerClinVarRelease(dir, {
    ...releaseInput(lake, "2026-02", "2026-02-01T00:00:00Z", "target raw source", [
      {
        assertionId: "VCV000001",
        temporalKey: "vcv:000001",
        recordScope: "variation_aggregate",
        variationId: "1",
        conditionId: "MONDO:0000001",
        conditionLabel: "Example condition",
        geneIds: ["HGNC:1", "HGNC:2"],
        clinicalSignificance: "Likely pathogenic",
        reviewStatus: "criteria provided, single submitter",
      },
      {
        assertionId: "VCV000002",
        temporalKey: "vcv:000002",
        recordScope: "variation_aggregate",
        variationId: "2",
        clinicalSignificance: "Benign",
        reviewStatus: "reviewed by expert panel",
      },
      {
        assertionId: "VCV000003",
        temporalKey: "vcv:000003",
        recordScope: "variation_aggregate",
        variationId: "3",
        clinicalSignificance: "Uncertain significance",
      },
    ]),
    recordedAt: "2026-02-02T00:00:00Z",
  });

  assert.ok(target.duckLakeSnapshotId > baseline.duckLakeSnapshotId);
  assert.equal((await getClinVarRelease(dir, lake, baseline.releaseId))?.releaseDigest, baseline.releaseDigest);
  assert.deepEqual((await listClinVarReleases(dir, lake)).map((release) => release.releaseId), ["2026-02", "2026-01"]);
  await assert.rejects(
    () => getClinVarRelease(dir, {
      lakeId: lake.lakeId,
      catalogPath: join(dir, "another-host", "catalog.ducklake"),
      dataPath: join(dir, "another-host", "data"),
    }, baseline.releaseId),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /different DuckLake host configuration/.test(error.message),
  );

  const cas = fsCasStore(join(dir, ".pi", "bio-agent", "cas"));
  assert.equal(await cas.has({ algorithm: "sha256", digest: baseline.rawDigest.slice("sha256:".length) }), true);
  assert.equal(await cas.has({ algorithm: "sha256", digest: baseline.normalizedDigest.slice("sha256:".length) }), true);

  const graph = await runClinVarAssertionGraph(dir, lake, baseline, {
    runId: "clinvar-baseline-graph",
    now: "2026-02-03T00:00:00Z",
  });
  assert.ok(graph.rows.some((row) => row.predicate === "clinvar:about_variation" && row.to_id === "clinvar-variation:1"));
  assert.ok(graph.rows.some((row) => row.predicate === "clinvar:about_condition" && row.to_id === "clinvar-condition:MONDO:0000001"));
  assert.ok(graph.rows.some((row) => row.predicate === "clinvar:mentions_gene" && row.to_id === "gene:HGNC:2"));
  assert.equal(graph.rows.some((row) => row.to_id === "clinvar-variation:3"), false, "the baseline snapshot cannot see a later release record");
  assert.ok(graph.rows.every((row) => row.clinical_significance !== "Likely pathogenic"), "the baseline graph cannot see the later classification");

  const delta = await runClinVarClassificationDelta(dir, lake, baseline, target, {
    runId: "clinvar-release-delta",
    now: "2026-02-03T00:01:00Z",
  });
  const byTemporalKey = new Map(delta.rows.map((row) => [row.temporal_key, row]));
  assert.equal(byTemporalKey.get("vcv:000001")?.change_kind, "classification_changed");
  assert.equal(byTemporalKey.get("vcv:000001")?.baseline_clinical_significance, "Uncertain significance");
  assert.equal(byTemporalKey.get("vcv:000001")?.target_clinical_significance, "Likely pathogenic");
  assert.equal(byTemporalKey.get("vcv:000002")?.change_kind, "unchanged");
  assert.equal(byTemporalKey.get("vcv:000003")?.change_kind, "introduced");
  assert.match(delta.casRefs.result ?? "", /^sha256:/);

  const store = await openBioStore(dir);
  try {
    const [{ leaked }] = await store.conn.all<{ leaked: bigint }>(
      "SELECT count(*) AS leaked FROM bio_observations WHERE value_json LIKE ?",
      [`%${rawBaseline}%`],
    );
    assert.equal(Number(leaked), 0, "raw source bytes remain CAS objects, not ledger values");
    await materializeBioEdgesAsOf(store.conn, "2026-02-04T00:00:00Z");
    const edges = await store.conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM bio_edges_as_of WHERE from_id = ? ORDER BY predicate, to_id",
      ["clinvar-release:clinvar:2026-01"],
    );
    assert.ok(edges.some((edge) => edge.predicate === "materialized_at" && edge.to_id === `ducklake-snapshot:clinvar:${baseline.duckLakeSnapshotId}`));
    assert.ok(edges.some((edge) => edge.predicate === "uses_source" && edge.to_id === baseline.rawUri));
    assert.ok(edges.some((edge) => edge.predicate === "produces" && edge.to_id === baseline.normalizedUri));
  } finally {
    store.close();
  }

  await assert.rejects(
    () => registerClinVarRelease(dir, {
      ...baselineRequest,
      rawSource: { ...baselineRequest.rawSource, bytes: Buffer.from("different raw source") },
      recordedAt: "2026-02-04T00:00:00Z",
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /different immutable content/.test(error.message),
  );
  await assert.rejects(
    () => runClinVarClassificationDelta(dir, lake, target, baseline),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /target release must be later/.test(error.message),
  );
});

test("a temporal task materializes only its baseline into the agent boundary", async () => {
  const root = await workspace();
  const evaluatorWorkspace = join(root, "evaluator");
  const agentWorkspace = join(root, "agent");
  const evaluatorLake = defaultClinVarDuckLakeConfig(evaluatorWorkspace);
  const baseline = await registerClinVarRelease(evaluatorWorkspace, releaseInput(
    evaluatorLake,
    "baseline-visible",
    "2026-01-01T00:00:00Z",
    "baseline source bytes",
    [{
      assertionId: "VCV000111",
      temporalKey: "vcv:000111",
      recordScope: "variation_aggregate",
      variationId: "111",
      conditionId: "MONDO:0000111",
      clinicalSignificance: "Uncertain significance",
      reviewStatus: "criteria provided, single submitter",
    }, {
      assertionId: "VCV000112",
      temporalKey: "vcv:000112",
      recordScope: "variation_aggregate",
      variationId: "112",
      conditionId: "MONDO:0000112",
      clinicalSignificance: "Uncertain significance",
      reviewStatus: "criteria provided, single submitter",
    }, {
      assertionId: "VCV000113",
      temporalKey: "vcv:000113",
      recordScope: "variation_aggregate",
      variationId: "113",
      conditionId: "MONDO:0000113",
      clinicalSignificance: "Uncertain significance",
      reviewStatus: "criteria provided, single submitter",
    }],
  ));
  const target = await registerClinVarRelease(evaluatorWorkspace, releaseInput(
    evaluatorLake,
    "target-hidden",
    "2026-02-01T00:00:00Z",
    "TARGET-MUST-NOT-LEAK",
    [{
      assertionId: "VCV000111",
      temporalKey: "vcv:000111",
      recordScope: "variation_aggregate",
      variationId: "111",
      conditionId: "MONDO:0000111",
      clinicalSignificance: "Likely pathogenic",
      reviewStatus: "criteria provided, single submitter",
    }, {
      assertionId: "VCV000112",
      temporalKey: "vcv:000112",
      recordScope: "variation_aggregate",
      variationId: "112",
      conditionId: "MONDO:0000112",
      clinicalSignificance: "Uncertain significance",
      reviewStatus: "criteria provided, single submitter",
    }],
  ));
  const isolation = buildClinVarTemporalIsolationReceipt({
    mode: "host_enforced",
    agentBoundaryId: "agent-sandbox-001",
    evaluatorBoundaryId: "evaluator-sandbox-001",
    targetAccess: "evaluator_only",
  });
  const evaluatorSecret = commitmentSecret();
  const aliasedAgentWorkspace = join(root, "agent-boundary-alias");
  await fs.symlink(evaluatorWorkspace, aliasedAgentWorkspace, "dir");
  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace: aliasedAgentWorkspace,
      evaluatorLake,
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: evaluatorSecret,
      isolationReceipt: isolation,
      taskId: "symlinked-boundary-must-fail",
      recordedAt: "2026-02-02T00:00:00Z",
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /non-overlapping host boundaries/.test(error.message),
  );
  const prepared = await prepareClinVarTemporalTask({
    evaluatorWorkspace,
    agentWorkspace,
    evaluatorLake,
    baseline,
    target,
    candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
    targetCommitmentSecret: evaluatorSecret,
    isolationReceipt: isolation,
    taskId: "temporal-blind-001",
    recordedAt: "2026-02-02T00:00:00Z",
  });

  const agentTask = await getClinVarTemporalTask(agentWorkspace, "temporal-blind-001");
  assert.ok(agentTask);
  assert.equal(agentTask.task.taskDigest, prepared.task.taskDigest);
  assert.equal(agentTask.task.targetCommitment, prepared.task.targetCommitment);
  assert.equal(JSON.stringify(agentTask.task).includes(target.releaseId), false);
  assert.equal(JSON.stringify(agentTask.task).includes("TARGET-MUST-NOT-LEAK"), false);
  assert.equal(JSON.stringify(agentTask.task).includes("Likely pathogenic"), false);
  const agentLake = defaultClinVarDuckLakeConfig(agentWorkspace);
  assert.deepEqual(
    (await listClinVarReleases(agentWorkspace, agentLake)).map((release) => release.releaseId),
    [baseline.releaseId],
    "the agent catalog has exactly the copied baseline release",
  );

  const agentTaskArtifact = await fs.readFile(
    fsCasStore(join(agentWorkspace, ".pi", "bio-agent", "cas")).pathFor({
      algorithm: "sha256",
      digest: agentTask.taskArtifactDigest.slice("sha256:".length),
    }),
    "utf8",
  );
  assert.equal(agentTaskArtifact.includes(target.releaseId), false);
  assert.equal(agentTaskArtifact.includes("TARGET-MUST-NOT-LEAK"), false);
  assert.equal(agentTaskArtifact.includes(evaluatorSecret.toString("hex")), false);
  const agentStore = await openBioStore(agentWorkspace);
  try {
    const [{ targetLeaks }] = await agentStore.conn.all<{ targetLeaks: bigint }>(
      "SELECT count(*) AS targetLeaks FROM bio_observations WHERE value_json LIKE ? OR value_json LIKE ?",
      [`%${target.releaseId}%`, "%TARGET-MUST-NOT-LEAK%"],
    );
    assert.equal(Number(targetLeaks), 0, "agent ledger records an opaque target commitment, not target content");
    const [{ secretReferences }] = await agentStore.conn.all<{ secretReferences: bigint }>(
      "SELECT count(*) AS secretReferences FROM bio_observations WHERE predicate = 'uses_secret'",
    );
    assert.equal(Number(secretReferences), 0, "the evaluator commitment secret is not an agent ledger artifact");
  } finally {
    agentStore.close();
  }
  const evaluatorStore = await openBioStore(evaluatorWorkspace);
  let evaluatorSecretUri: string;
  try {
    const secretRows = await evaluatorStore.conn.all<{ object_id: string }>(
      "SELECT object_id FROM bio_observations WHERE subject_id = ? AND predicate = 'uses_secret'",
      ["clinvar-temporal-evaluation:temporal-blind-001"],
    );
    assert.equal(secretRows.length, 1);
    evaluatorSecretUri = secretRows[0]!.object_id;
    assert.match(evaluatorSecretUri, /^cas:sha256:[0-9a-f]{64}$/);
  } finally {
    evaluatorStore.close();
  }
  const agentCas = fsCasStore(join(agentWorkspace, ".pi", "bio-agent", "cas"));
  assert.equal(await agentCas.has({ algorithm: "sha256", digest: evaluatorSecretUri.slice("cas:sha256:".length) }), false);
  assert.equal(await agentCas.has({ algorithm: "sha256", digest: target.rawDigest.slice("sha256:".length) }), false);
  assert.equal(await agentCas.has({ algorithm: "sha256", digest: target.normalizedDigest.slice("sha256:".length) }), false);

  const differentSecretTask = await prepareClinVarTemporalTask({
    evaluatorWorkspace,
    agentWorkspace: join(root, "agent-with-different-secret"),
    evaluatorLake,
    baseline,
    target,
    candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
    targetCommitmentSecret: Buffer.alloc(32, 18),
    isolationReceipt: isolation,
    taskId: "temporal-blind-002",
    recordedAt: "2026-02-02T00:00:00Z",
  });
  assert.notEqual(differentSecretTask.task.targetCommitment, prepared.task.targetCommitment);

  const agentGraph = await runClinVarAssertionGraph(agentWorkspace, agentLake, agentTask.agentRelease, {
    runId: "temporal-agent-baseline-graph",
    now: "2026-02-03T00:00:00Z",
    hostCapabilityReceipts: [agentTask.task.isolation],
  });
  assert.equal(agentGraph.rows.some((row) => row.clinical_significance === "Likely pathogenic"), false);
  const agentCandidates = await runClinVarTemporalCandidates(agentWorkspace, agentLake, "temporal-blind-001", {
    runId: "temporal-agent-candidates",
    now: "2026-02-03T00:00:30Z",
  });
  assert.deepEqual(agentCandidates.rows.map((row) => [row.temporal_key, row.clinical_significance]), [
    ["vcv:000111", "Uncertain significance"],
    ["vcv:000112", "Uncertain significance"],
    ["vcv:000113", "Uncertain significance"],
  ]);

  const evaluation = await getClinVarTemporalEvaluation(evaluatorWorkspace, evaluatorLake, "temporal-blind-001");
  assert.ok(evaluation);
  assert.equal(evaluation.target.releaseId, target.releaseId, "only the evaluator record identifies the target release");
  assert.deepEqual(evaluation.isolation, isolation);
  const delta = await runClinVarTemporalEvaluation(evaluatorWorkspace, evaluatorLake, "temporal-blind-001", {
    runId: "temporal-evaluator-delta",
    now: "2026-02-03T00:01:00Z",
  });
  assert.equal(delta.rows[0]?.change_kind, "classification_changed");
  assert.equal(delta.rows[0]?.target_clinical_significance, "Likely pathogenic");

  const proposalRequest = {
    agentWorkspace,
    agentLake,
    taskId: "temporal-blind-001",
    proposalSetId: "spark-proposals-001",
    candidateRunId: agentCandidates.runId,
    actor: {
      id: "pi-agent:clinvar-reclassification",
      version: "1.0.0",
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      contractDigest: digest("clinvar-reclassification-prompt-tools-policy@1.0.0"),
    },
    proposals: [
      {
        temporalKey: "vcv:000111",
        priorityRank: 1,
        prediction: "classification" as const,
        predictedClinicalSignificance: "Likely pathogenic",
        confidence: 0.73,
        rationale: "Baseline evidence supports prioritizing this source assertion for later-label review.",
      },
      {
        temporalKey: "vcv:000113",
        priorityRank: 2,
        prediction: "removed" as const,
        confidence: 0.68,
        rationale: "The baseline-only evidence supports prioritizing possible source-record removal.",
      },
      {
        temporalKey: "vcv:000112",
        priorityRank: 3,
        prediction: "classification" as const,
        predictedClinicalSignificance: "Uncertain significance",
        confidence: 0.64,
        rationale: "The baseline-only evidence does not support a source-label change prediction.",
      },
    ],
    recordedAt: "2026-02-03T00:02:00Z",
  };
  const proposalSet = await registerClinVarTemporalProposalSet(proposalRequest);
  const repeatedProposalSet = await registerClinVarTemporalProposalSet(proposalRequest);
  assert.deepEqual(repeatedProposalSet, proposalSet, "the same proposal artifact is idempotent");
  assert.match(proposalSet.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(proposalSet.proposalSet.candidateRun.resultDigest, agentCandidates.casRefs.result);
  assert.equal(proposalSet.proposalSet.actor.model, "gpt-5.3-codex-spark");
  assert.equal(
    (await getClinVarTemporalProposalSet(agentWorkspace, "spark-proposals-001"))?.proposalSet.proposalDigest,
    proposalSet.proposalSet.proposalDigest,
  );
  const proposalStore = await openBioStore(agentWorkspace);
  try {
    await materializeBioEdgesAsOf(proposalStore.conn, "2026-02-04T00:00:00Z");
    const proposalEdges = await proposalStore.conn.all<{ predicate: string; to_id: string }>(
      "SELECT predicate, to_id FROM bio_edges_as_of WHERE from_id = ? ORDER BY predicate, to_id",
      ["clinvar-temporal-proposal-set:spark-proposals-001"],
    );
    assert.ok(proposalEdges.some((edge) => edge.predicate === "responds_to"
      && edge.to_id === "clinvar-temporal-task:temporal-blind-001"));
    assert.ok(proposalEdges.some((edge) => edge.predicate === "uses_run"
      && edge.to_id === "run:temporal-agent-candidates"));
    assert.ok(proposalEdges.some((edge) => edge.predicate === "proposed_by"
      && edge.to_id === "actor:pi-agent:clinvar-reclassification@1.0.0"));
    const proposalSources = await proposalStore.conn.all<{ source: string }>(
      "SELECT DISTINCT source FROM bio_observations WHERE subject_id = ? ORDER BY source",
      ["clinvar-temporal-proposal-set:spark-proposals-001"],
    );
    assert.deepEqual(
      proposalSources.map((row) => row.source),
      ["pi-bio-workbench:clinvar-temporal"],
      "caller-supplied actor identity must not replace the component provenance source",
    );
    const taskRunEdges = await proposalStore.conn.all<{ predicate: string; to_id: string }>(
      "SELECT predicate, to_id FROM bio_edges_as_of WHERE from_id = ? AND predicate = 'produces_run'",
      ["clinvar-temporal-task:temporal-blind-001"],
    );
    assert.ok(taskRunEdges.some((edge) => edge.to_id === "run:temporal-agent-candidates"));
  } finally {
    proposalStore.close();
  }

  await assert.rejects(
    () => registerClinVarTemporalProposalSet({
      ...proposalRequest,
      proposalSetId: "missing-candidate-proposal",
      proposals: [],
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /cover every candidate exactly once/.test(error.message),
  );
  await assert.rejects(
    () => registerClinVarTemporalProposalSet({
      ...proposalRequest,
      proposalSetId: "wrong-candidate-run",
      candidateRunId: agentGraph.runId,
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /not a succeeded clinical\.clinvar_temporal_candidates/.test(error.message),
  );

  const scored = await runClinVarTemporalProposalEvaluation({
    evaluatorWorkspace,
    evaluatorLake,
    agentWorkspace,
    agentLake,
    proposalSetId: proposalSet.proposalSet.proposalSetId,
    scoreRunId: "temporal-proposal-scores",
    metricsRunId: "temporal-proposal-metrics",
    now: "2026-02-03T00:03:00Z",
  });
  assert.equal(scored.scores.rows.length, 3);
  assert.equal(scored.scores.rows[0]?.score_status, "correct");
  assert.equal(scored.scores.rows[0]?.target_changed, true);
  assert.equal(scored.scores.rows[0]?.correctly_predicted_change, true);
  assert.equal(scored.scores.rows[1]?.score_status, "correct");
  assert.equal(scored.scores.rows[1]?.change_kind, "removed");
  assert.equal(scored.scores.rows[1]?.target_changed, true);
  assert.equal(scored.scores.rows[2]?.score_status, "correct");
  assert.equal(scored.scores.rows[2]?.target_changed, false);
  const scoredMetrics = scored.metrics.rows[0]!;
  assert.equal(Number(scoredMetrics.total_candidates), 3);
  assert.equal(Number(scoredMetrics.answered_candidates), 3);
  assert.equal(Number(scoredMetrics.correct_predictions), 3);
  assert.equal(Number(scoredMetrics.classification_predictions), 2);
  assert.equal(Number(scoredMetrics.correct_classification_predictions), 2);
  assert.equal(Number(scoredMetrics.removal_predictions), 1);
  assert.equal(Number(scoredMetrics.correct_removal_predictions), 1);
  assert.equal(scoredMetrics.coverage, 1);
  assert.equal(scoredMetrics.prediction_accuracy, 1);
  assert.equal(scoredMetrics.classification_accuracy, 1);
  assert.equal(scoredMetrics.removal_accuracy, 1);
  assert.equal(scoredMetrics.target_change_recall, 1);
  assert.equal(scoredMetrics.target_change_reciprocal_rank, 1);
  assert.equal(scoredMetrics.correct_change_reciprocal_rank, 1);
  const scoreReplayDigest = scored.scores.casRefs.replay!;
  const scoreReplay = await fs.readFile(
    fsCasStore(join(evaluatorWorkspace, ".pi", "bio-agent", "cas")).pathFor({
      algorithm: "sha256",
      digest: scoreReplayDigest.slice("sha256:".length),
    }),
    "utf8",
  );
  assert.match(scoreReplay, /protectedSessionBindingsDigest/);
  assert.equal(scoreReplay.includes("Baseline evidence supports prioritizing"), false, "proposal bytes are not serialized into replay");

  const abstainedProposalSet = await registerClinVarTemporalProposalSet({
    ...proposalRequest,
    proposalSetId: "spark-abstentions-001",
    proposals: [
      {
        temporalKey: "vcv:000112",
        priorityRank: 1,
        prediction: "abstain",
        confidence: 0.25,
        rationale: "The baseline-only evidence is insufficient for a later-label prediction.",
      },
      {
        temporalKey: "vcv:000113",
        priorityRank: 2,
        prediction: "abstain",
        confidence: 0.25,
        rationale: "The baseline-only evidence is insufficient for a later-label prediction.",
      },
      {
        temporalKey: "vcv:000111",
        priorityRank: 3,
        prediction: "abstain",
        confidence: 0.25,
        rationale: "The baseline-only evidence is insufficient for a later-label prediction.",
      },
    ],
    recordedAt: "2026-02-03T00:04:00Z",
  });
  const abstained = await runClinVarTemporalProposalEvaluation({
    evaluatorWorkspace,
    evaluatorLake,
    agentWorkspace,
    agentLake,
    proposalSetId: abstainedProposalSet.proposalSet.proposalSetId,
    scoreRunId: "temporal-abstention-scores",
    metricsRunId: "temporal-abstention-metrics",
    now: "2026-02-03T00:05:00Z",
  });
  assert.equal(abstained.scores.rows[0]?.score_status, "abstained");
  assert.equal(abstained.scores.rows[0]?.is_correct, null);
  assert.equal(abstained.metrics.rows[0]?.coverage, 0);
  assert.equal(abstained.metrics.rows[0]?.prediction_accuracy, null);
  assert.equal(abstained.metrics.rows[0]?.classification_accuracy, null);
  assert.equal(abstained.metrics.rows[0]?.target_change_recall, 0);
  assert.equal(abstained.metrics.rows[0]?.target_change_reciprocal_rank, 0.5, "ranking is scored independently of abstention");
  assert.equal(abstained.metrics.rows[0]?.correct_change_reciprocal_rank, 0);

  const scoredStore = await openBioStore(evaluatorWorkspace);
  try {
    await materializeBioEdgesAsOf(scoredStore.conn, "2026-02-04T00:00:00Z");
    const evaluationEdges = await scoredStore.conn.all<{ predicate: string; to_id: string }>(
      "SELECT predicate, to_id FROM bio_edges_as_of WHERE from_id = ? ORDER BY predicate, to_id",
      ["clinvar-temporal-proposal-evaluation:spark-proposals-001"],
    );
    assert.ok(evaluationEdges.some((edge) => edge.predicate === "evaluates_proposal_set"
      && edge.to_id === "clinvar-temporal-proposal-set:spark-proposals-001"));
    assert.ok(evaluationEdges.some((edge) => edge.predicate === "produces_run"
      && edge.to_id === "run:temporal-proposal-scores"));
    assert.ok(evaluationEdges.some((edge) => edge.predicate === "produces_run"
      && edge.to_id === "run:temporal-proposal-metrics"));
  } finally {
    scoredStore.close();
  }

  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace: evaluatorWorkspace,
      evaluatorLake,
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: commitmentSecret(),
      isolationReceipt: isolation,
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /non-overlapping host boundaries/.test(error.message),
  );
  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace,
      evaluatorLake,
      agentLake: {
        lakeId: "agent-clinvar",
        catalogPath: join(evaluatorLake.dataPath, "nested-agent-catalog.ducklake"),
        dataPath: join(agentWorkspace, "agent-clinvar-data"),
      },
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: commitmentSecret(),
      isolationReceipt: isolation,
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /catalog\/data paths must be non-overlapping/.test(error.message),
  );

  const contaminatedWorkspace = join(root, "contaminated-agent");
  const contaminatedLake = defaultClinVarDuckLakeConfig(contaminatedWorkspace);
  await registerClinVarRelease(contaminatedWorkspace, releaseInput(
    contaminatedLake,
    "other-release",
    "2026-01-15T00:00:00Z",
    "unrelated release that must not become task context",
    [{
      assertionId: "VCV000999",
      temporalKey: "vcv:000999",
      recordScope: "variation_aggregate",
      variationId: "999",
      clinicalSignificance: "Uncertain significance",
    }],
  ));
  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace: contaminatedWorkspace,
      evaluatorLake,
      agentLake: contaminatedLake,
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: commitmentSecret(),
      isolationReceipt: isolation,
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /empty or contain only the exact baseline release/.test(error.message),
  );
  await mutateAgentAssertionCatalog(agentLake, baseline.releaseId);
  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace,
      evaluatorLake,
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: Buffer.alloc(32, 19),
      isolationReceipt: isolation,
      taskId: "temporal-blind-mutated-catalog",
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /assertions do not match the exact normalized baseline/.test(error.message),
  );
  await assert.rejects(
    () => prepareClinVarTemporalTask({
      evaluatorWorkspace,
      agentWorkspace: join(root, "agent-with-short-secret"),
      evaluatorLake,
      baseline,
      target,
      candidatePolicy: { baselineClinicalSignificances: ["Uncertain significance"] },
      targetCommitmentSecret: Buffer.alloc(31, 1),
      isolationReceipt: isolation,
    }),
    (error: unknown) => error instanceof ClinVarTemporalInputError && /at least 32 bytes/.test(error.message),
  );
});
