import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fsCasStore,
  JOB_STEP_CHECKPOINT_SCHEMA,
  jobStepCheckpointKey,
  observationAsOfKey,
  openBioStore,
  recordObservationBatch,
} from "pi-bio-agent";
import {
  getClinicalAnalysis,
  getClinicalReviewQueue,
  listClinicalAnalyses,
  listClinicalReanalysisQueue,
  readEvidencePacket,
  runClinicalGenomicsWorkbench,
  updateClinicalReviewDisposition,
} from "../src/clinical-genomics.js";
import { loadRecordedGroundingRuntime } from "../src/recorded-grounding.js";
import { localMonarchFixtureRuntime } from "../src/monarch-host.js";
import { localCandidateVariantSearchRuntime } from "../src/candidate-variant-search.js";
import type { VepAnnotationRuntime } from "../src/clinical-genomics.js";
import { startVepFixture } from "./vep-fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-clinical-"));
  await fs.cp(fixtureRoot, dir, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  return dir;
}

async function runFixture(
  exampleDir: string,
    request: Omit<Parameters<typeof runClinicalGenomicsWorkbench>[0], "exampleDir" | "grounding" | "hypotheses" | "variantSearch" | "vep">,
    injectedVep?: VepAnnotationRuntime,
) {
  const fixture = injectedVep ? undefined : await startVepFixture();
  try {
    return await runClinicalGenomicsWorkbench({
      ...request,
      exampleDir,
      grounding: await loadRecordedGroundingRuntime(join(exampleDir, "data", "grounding_proposals.json")),
      hypotheses: localMonarchFixtureRuntime(exampleDir),
      variantSearch: localCandidateVariantSearchRuntime(exampleDir),
      vep: injectedVep ?? fixture!.runtime,
    });
  } finally {
    if (fixture) await fixture.close();
  }
}

type SeededAnalysis = {
  analysisId: string;
  caseId: string;
  recordedAt: string;
};

async function seedRecordedAnalysisHistory(
  exampleDir: string,
  template: Awaited<ReturnType<typeof runFixture>>["packet"],
  entries: readonly SeededAnalysis[],
): Promise<void> {
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  const observations = [];
  for (const entry of entries) {
    const packet = JSON.parse(
      JSON.stringify(template)
        .replaceAll(template.analysisId, entry.analysisId)
        .replaceAll(template.caseId, entry.caseId),
    ) as typeof template;
    packet.analysisId = entry.analysisId;
    packet.caseId = entry.caseId;
    packet.generatedAt = entry.recordedAt;
    const bytes = Buffer.from(JSON.stringify(packet), "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const packetDigest = `sha256:${digest}`;
    const packetUri = `cas:${packetDigest}`;
    await cas.put({ algorithm: "sha256", digest, sizeBytes: bytes.length, mediaType: "application/vnd.pi-bio.workbench.evidence+json" }, bytes);
    observations.push(
      {
        statementKey: `analysis:${entry.analysisId}`,
        subjectId: `analysis:${entry.analysisId}`,
        predicate: "analysis",
        value: {
          schema: "pi-bio.workbench.clinical_analysis.v1",
          status: "succeeded",
          case_id: entry.caseId,
          packet_digest: packetDigest,
          packet_uri: packetUri,
          review_items: packet.summary.reviewQueue.length,
        },
        recordedAt: entry.recordedAt,
        source: "test:clinical-history",
        digest: packetDigest,
      },
      {
        statementKey: jobStepCheckpointKey(entry.analysisId, "packet"),
        subjectId: `job:${entry.analysisId}`,
        predicate: "job_step_checkpoint",
        value: {
          schema: JOB_STEP_CHECKPOINT_SCHEMA,
          runId: entry.analysisId,
          stepId: "packet",
          value: {
            schema: "pi-bio.workbench.packet_checkpoint.v1",
            packetDigest,
            packetUri,
          },
        },
        recordedAt: entry.recordedAt,
        source: "test:clinical-history",
        digest: packetDigest,
        attrs: { step_id: "packet" },
      },
    );
  }
  const store = await openBioStore(exampleDir);
  try {
    await recordObservationBatch(store.conn, observations);
  } finally {
    store.close();
  }
}

test("clinical workbench reconciles direct and inverted traversal into one evidence relation", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-evidence",
    now: "2026-07-05T12:00:00Z",
  });

  assert.equal(out.workflow.executedSteps, 8);
  assert.equal(out.workflow.reusedSteps, 0);
  assert.equal(out.packet.schema, "pi-bio.workbench.evidence_packet.v1");
  assert.equal(out.packet.summary.kernelScope, "evidence routing only; not a complete clinical classification kernel");
  assert.equal(out.packet.summary.directCandidates, 1);
  assert.equal(out.packet.summary.directAbstentions, 1);
  assert.equal(out.packet.summary.phenotypeHypotheses, out.packet.stages.hypotheses.rows.length);
  assert.equal(out.packet.summary.resolvedCandidateGenes, 2);
  assert.equal(out.packet.summary.unresolvedCandidateGenes, 0);
  assert.equal(out.packet.summary.searchedCandidateGenes, 2);
  assert.equal(out.packet.summary.unsearchedCandidateGenes, 0);
  assert.equal(out.packet.summary.selectedAlleles, 3);
  assert.equal(out.packet.summary.invertedSupportedHypotheses, 1);
  assert.equal(out.packet.summary.invertedGaps, 1);
  assert.equal(out.packet.summary.invertedUnsearched, 0);
  assert.equal(out.packet.summary.conflicts, 2);
  assert.equal(out.packet.summary.reanalysisSignals, 1);
  assert.equal(out.packet.grounding.mode, "pre+post");
  assert.equal(out.packet.grounding.groundingId, "grounding:analysis-evidence");
  assert.equal(out.packet.grounding.acceptedCount, 4);
  assert.equal(out.packet.grounding.rejectedCount, 0);

  const direct = out.packet.lanes.direct.rows;
  assert.equal(direct.find((row) => row.variant_key === "17-43093464-A-T")?.variant_status, "curated_plp_candidate");
  assert.equal(direct.find((row) => row.variant_key === "2-47637258-C-CT")?.variant_bucket, "abstain_no_frequency");
  assert.equal(direct.find((row) => row.variant_key === "3-300-C-T")?.conflict, "benign_vs_predicted_loss_of_function");

  const inverted = out.packet.lanes.inverted.rows;
  const supported = inverted.find((row) => row.gene === "GENEB" && row.evidence_status === "genotype_supports_hypothesis");
  assert.equal(supported?.gene_id, "HGNC:GENEB");
  assert.equal(supported?.hypothesis_rank, 1);
  assert.deepEqual(supported?.gene_disease_predicates, ["biolink:causes"]);
  assert.equal(supported?.vep_impact, "HIGH");
  assert.equal(supported?.vep_consequence, "stop_gained");
  assert.equal(supported?.vep_allele_frequency, 0.0002);
  assert.ok(inverted.some((row) => row.gene === "GENEH" && row.evidence_status === "hypothesis_without_supporting_variant"));
  assert.ok(out.packet.summary.reviewQueue.some((row) => row.kind === "review_missing_genotype_support" && row.target === "hypothesis:MONDO:GENEH:GENEH"));
  assert.ok(out.packet.summary.reviewQueue.some((row) => row.kind === "resolve_frequency" && row.target === "variant:2-47637258-C-CT"));
});

test("clinical analyses project durable human review state without changing recorded evidence", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-review-projection",
    now: "2026-07-05T12:00:00Z",
  });

  const initial = await getClinicalReviewQueue(exampleDir, out.analysisId);
  assert.equal(initial.found, true);
  if (!initial.found) throw new Error("expected recorded review queue");
  const frequencyReview = initial.reviews.find((item) => item.kind === "resolve_frequency");
  assert.ok(frequencyReview);
  assert.equal(frequencyReview.status, "open");

  const updated = await updateClinicalReviewDisposition(exampleDir, out.analysisId, {
    reviewId: frequencyReview.reviewId,
    status: "needs_follow_up",
    note: "Obtain a declared frequency source.",
    now: "2026-07-05T12:05:00Z",
  });
  assert.equal(updated.found, true);
  if (!updated.found) throw new Error("expected updated review queue");
  const recordedReview = updated.reviews.find((item) => item.reviewId === frequencyReview.reviewId);
  assert.deepEqual(recordedReview && {
    status: recordedReview.status,
    note: recordedReview.note,
    kind: recordedReview.kind,
    target: recordedReview.target,
  }, {
    status: "needs_follow_up",
    note: "Obtain a declared frequency source.",
    kind: "resolve_frequency",
    target: "variant:2-47637258-C-CT",
  });

  const analyses = await listClinicalAnalyses(exampleDir, { caseId: "CASE-RD-001" });
  assert.deepEqual(analyses.map((item) => item.analysisId), [out.analysisId]);
  assert.equal(analyses[0]?.packetDigest, out.packetDigest);

  const queue = await listClinicalReanalysisQueue(exampleDir);
  assert.equal(queue.length, 1);
  assert.deepEqual(queue[0] && {
    analysisId: queue[0].analysisId,
    state: queue[0].state,
    needsFollowUpItems: queue[0].needsFollowUpItems,
    evidenceGaps: queue[0].evidenceGaps,
  }, {
    analysisId: out.analysisId,
    state: "needs_follow_up",
    needsFollowUpItems: 1,
    evidenceGaps: 2,
  });

  const reread = await getClinicalAnalysis(exampleDir, out.analysisId);
  assert.equal(reread.found, true);
  if (!reread.found) throw new Error("expected recorded analysis");
  assert.deepEqual(reread.packet, out.packet, "review state is a separate ledger observation, not a packet mutation");

  const stale = await updateClinicalReviewDisposition(exampleDir, out.analysisId, {
    reviewId: frequencyReview.reviewId,
    status: "acknowledged",
    now: "2026-07-05T12:04:00Z",
  });
  assert.equal(stale.found, true);
  if (!stale.found) throw new Error("expected stale review update to be recorded monotonically");
  const staleReview = stale.reviews.find((item) => item.reviewId === frequencyReview.reviewId);
  assert.equal(staleReview?.status, "acknowledged");
  assert.ok(staleReview?.updatedAt);
  assert.ok(Date.parse(staleReview.updatedAt) > Date.parse("2026-07-05T12:05:00Z"));

  const store = await openBioStore(exampleDir);
  try {
    const reviewObservation = await observationAsOfKey(
      store.conn,
      `clinical-review:${out.analysisId}:${frequencyReview.reviewId}`,
      "9999-12-31T23:59:59.999Z",
    );
    const reviewLink = await observationAsOfKey(
      store.conn,
      `analysis:${out.analysisId}:has_review:${frequencyReview.reviewId}`,
      "9999-12-31T23:59:59.999Z",
    );
    assert.ok(reviewObservation);
    assert.ok(reviewLink);
    assert.equal(
      Date.parse(reviewLink.recorded_at),
      Date.parse(reviewObservation.recorded_at),
      "the graph relation advances with the effective monotonic review timestamp",
    );
  } finally {
    store.close();
  }
});

test("reanalysis selects the latest packet per case before applying its cohort output limit", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-cohort-template",
    now: "2026-01-01T00:00:00Z",
  });
  const newerSameCase = Array.from({ length: 500 }, (_value, index) => ({
    analysisId: `analysis-case-one-${String(index).padStart(3, "0")}`,
    caseId: "CASE-RD-001",
    recordedAt: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
  }));
  await seedRecordedAnalysisHistory(exampleDir, out.packet, [
    ...newerSameCase,
    {
      analysisId: "analysis-case-two-latest",
      caseId: "CASE-RD-002",
      recordedAt: "2026-06-30T23:59:59.000Z",
    },
  ]);

  const queue = await listClinicalReanalysisQueue(exampleDir, { limit: 2 });
  assert.deepEqual(queue.map((entry) => [entry.caseId, entry.analysisId]), [
    ["CASE-RD-001", "analysis-case-one-499"],
    ["CASE-RD-002", "analysis-case-two-latest"],
  ]);
});

test("SDK entry resolves a relative workspace exactly once", async () => {
  const exampleDir = await copyFixture();
  const vep = await startVepFixture();
  let out;
  try {
    out = await runClinicalGenomicsWorkbench({
      exampleDir: relative(process.cwd(), exampleDir),
      caseId: "CASE-RD-001",
      analysisId: "analysis-relative-workspace",
      now: "2026-07-05T12:00:00Z",
      grounding: await loadRecordedGroundingRuntime(join(exampleDir, "data", "grounding_proposals.json")),
      hypotheses: localMonarchFixtureRuntime(exampleDir),
      variantSearch: localCandidateVariantSearchRuntime(exampleDir),
      vep: vep.runtime,
    });
  } finally {
    await vep.close();
  }
  assert.ok(out.analysisDbPath.startsWith(resolve(exampleDir)));
  assert.equal(out.workflow.executedSteps, 8);
  assert.equal(vep.requests(), 3, "the SQL-native VEP transport retries two transient 503 responses");
});

test("indexed inverted traversal preserves multiallelic allele alignment before evidence reduction", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-multiple-variants",
    now: "2026-07-05T12:00:00Z",
  });
  const selected = out.packet.stages.variantSearch.rows.filter((row) => row.record_kind === "variant");
  assert.deepEqual(
    selected.map((row) => row.variant_key).sort(),
    ["17-43093464-A-T", "17-43093470-C-G", "17-43093470-C-T"],
  );
  assert.deepEqual(
    selected.filter((row) => row.pos === 43093470).map((row) => [row.alt, row.consequence, row.allele_frequency]),
    [
      ["G", "missense_variant", 0.0003000000142492354],
      ["T", "stop_gained", 0.019999999552965164],
    ],
  );
  const geneB = out.packet.lanes.inverted.rows.filter((row) => row.gene === "GENEB");
  assert.deepEqual(geneB.map((row) => row.variant_key).sort(), ["17-43093464-A-T", "17-43093470-C-T"]);
  assert.equal(out.packet.summary.invertedSupportedHypotheses, 1, "variant rows do not inflate hypothesis cardinality");
});

test("a phenotype hypothesis is not called missing genotype support without completed search coverage", async () => {
  const exampleDir = await copyFixture();
  const intervalPath = join(exampleDir, "data", "gene_intervals.csv");
  const intervals = await fs.readFile(intervalPath, "utf8");
  await fs.writeFile(intervalPath, intervals.split("\n").filter((line) => !line.startsWith("HGNC:GENEH,")).join("\n"));
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-unsearched-hypothesis",
    now: "2026-07-05T12:00:00Z",
  });
  const geneH = out.packet.lanes.inverted.rows.find((row) => row.gene === "GENEH");
  assert.equal(geneH?.evidence_status, "hypothesis_not_searched");
  assert.equal(geneH?.missing_field, "variant_search");
  assert.equal(geneH?.review_kind, null);
  assert.equal(out.packet.summary.invertedGaps, 0);
  assert.equal(out.packet.summary.invertedUnsearched, 1);
  assert.equal(out.packet.summary.unresolvedCandidateGenes, 1);
  assert.equal(out.packet.summary.unsearchedCandidateGenes, 1);
});

test("an unranked status abstains even when prior and current labels are equal", async () => {
  const exampleDir = await copyFixture();
  await fs.appendFile(join(exampleDir, "data", "prior_assessment.csv"), "CASE-RD-001,7-100-A-G,not_reportable_by_screen\n");
  const orderPath = join(exampleDir, "data", "assessment_status_order.csv");
  const order = await fs.readFile(orderPath, "utf8");
  await fs.writeFile(orderPath, order.replace("not_reportable_by_screen,0\n", ""));
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-unknown-status",
    now: "2026-07-05T12:00:00Z",
  });
  assert.equal(
    out.packet.stages.reanalysis.rows.find((row) => row.variant_key === "7-100-A-G")?.change_status,
    "abstain_unknown_status",
  );
});

test("checkpoint replay digest rejects changed graph fixture bytes", async () => {
  const exampleDir = await copyFixture();
  await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-graph-input-change",
    now: "2026-07-05T12:00:00Z",
  });
  await fs.appendFile(
    join(exampleDir, "data", "monarch_edges.csv"),
    "MONDO:GENEH,biolink:has_phenotype,HP:0001250,false,infores:fixture,,ECO:0000001,\n",
  );
  await assert.rejects(() => runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-graph-input-change",
    now: "2026-07-05T12:05:00Z",
  }), /replay digest does not match/);
});

test("checkpoint replay digest rejects changed declared input bytes", async () => {
  const exampleDir = await copyFixture();
  await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-input-change",
    now: "2026-07-05T12:00:00Z",
  });
  await fs.appendFile(
    join(exampleDir, "data", "case_variants.csv"),
    "CASE-RD-001,17-43093466-C-T,GENEB,stop_gained,0.0001,Uncertain significance,het,inherited\n",
  );
  await assert.rejects(
    () => runFixture(exampleDir, {
      caseId: "CASE-RD-001",
      analysisId: "analysis-input-change",
      now: "2026-07-05T12:05:00Z",
    }),
    /replay digest does not match/,
  );
});

test("checkpoint replay digest rejects a changed indexed case-VCF identity", async () => {
  const exampleDir = await copyFixture();
  await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-vcf-index-change",
    now: "2026-07-05T12:00:00Z",
  });
  await fs.appendFile(join(exampleDir, "data", "case_variants.vcf.gz.tbi"), Buffer.from([0]));
  await assert.rejects(() => runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-vcf-index-change",
    now: "2026-07-05T12:05:00Z",
  }), /replay digest does not match/);
});

test("changed grounding composition invalidates checkpoint replay", async () => {
  const exampleDir = await copyFixture();
  await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-grounding-change",
    now: "2026-07-05T12:00:00Z",
  });
  const fixturePath = join(exampleDir, "data", "grounding_proposals.json");
  const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")) as { reviewer: { version: string } };
  fixture.reviewer.version = "2";
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
  await assert.rejects(() => runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-grounding-change",
    now: "2026-07-05T12:05:00Z",
  }), /replay digest does not match/);
});

test("same analysis id resumes from all durable checkpoints", async () => {
  const exampleDir = await copyFixture();
  const vep = await startVepFixture();
  let first;
  let resumed;
  try {
    first = await runFixture(exampleDir, {
      caseId: "CASE-RD-001",
      analysisId: "analysis-resume",
      now: "2026-07-05T12:00:00Z",
    }, vep.runtime);
    resumed = await runFixture(exampleDir, {
      caseId: "CASE-RD-001",
      analysisId: "analysis-resume",
      now: "2026-07-05T12:05:00Z",
    }, vep.runtime);
  } finally {
    await vep.close();
  }

  assert.equal(first.workflow.executedSteps, 8);
  assert.equal(resumed.workflow.executedSteps, 0);
  assert.equal(resumed.workflow.reusedSteps, 8);
  assert.equal(resumed.packetDigest, first.packetDigest);
  assert.equal(resumed.packet.generatedAt, "2026-07-05T12:00:00Z");
  assert.equal(vep.requests(), 3, "resuming reuses the VEP checkpoint without another fanout");

  const store = await openBioStore(exampleDir);
  try {
    const rows = await store.conn.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM bio_observations WHERE predicate = 'run' AND starts_with(subject_id, 'run:analysis-resume.')",
    );
    assert.equal(Number(rows[0]?.n), 9);
  } finally {
    store.close();
  }
});

test("packet and scientific runs are CAS-backed and connected in the ledger", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-provenance",
    now: "2026-07-05T12:00:00Z",
  });

  assert.deepEqual(await readEvidencePacket(exampleDir, out.packetDigest), out.packet);
  assert.deepEqual(await getClinicalAnalysis(exampleDir, out.analysisId), {
    found: true,
    analysisId: out.analysisId,
    packet: out.packet,
    packetDigest: out.packetDigest,
    packetUri: out.packetUri,
  });

  const receiptsAddress = out.packet.stages.hypotheses.casRefs?.receipts;
  assert.match(receiptsAddress ?? "", /^sha256:/);
  const cas = fsCasStore(join(exampleDir, ".pi", "bio-agent", "cas"));
  const receipts = JSON.parse(await fs.readFile(
    cas.pathFor({ algorithm: "sha256", digest: receiptsAddress!.slice(7) }),
    "utf8",
  )) as Array<{ sourceSnapshots?: Array<{ source: string }> }>;
  const graphSources = receipts.flatMap((receipt) => receipt.sourceSnapshots ?? []).map(({ source }) => source);
  assert.ok(graphSources.includes("file:data/monarch_edges.csv"));
  assert.ok(graphSources.includes("file:data/monarch_nodes.csv"));
  assert.ok(graphSources.includes("file:data/monarch_closure.csv"));

  const variantReceiptAddress = out.packet.stages.variantSearch.casRefs?.receipts;
  const variantReplayAddress = out.packet.stages.variantSearch.casRefs?.replay;
  assert.match(variantReceiptAddress ?? "", /^sha256:/);
  assert.match(variantReplayAddress ?? "", /^sha256:/);
  const variantReceipts = JSON.parse(await fs.readFile(
    cas.pathFor({ algorithm: "sha256", digest: variantReceiptAddress!.slice(7) }),
    "utf8",
  )) as Array<{
    sourceSnapshots?: Array<{ source: string; version?: string }>;
    provenance?: Array<{ notes?: string[] }>;
  }>;
  assert.ok(variantReceipts.flatMap((receipt) => receipt.sourceSnapshots ?? [])
    .some((source) => source.source === "file:data/case_variants.vcf.gz" && source.version?.includes("index-sha256:")));
  assert.ok(variantReceipts.flatMap((receipt) => receipt.provenance ?? []).flatMap((entry) => entry.notes ?? [])
    .includes("region:17:43090000-43100000,5:1000-2000"));
  const variantReplay = JSON.parse(await fs.readFile(
    cas.pathFor({ algorithm: "sha256", digest: variantReplayAddress!.slice(7) }),
    "utf8",
  )) as { manifest: { snapshot: { provides: { resources: Array<{ id: string; params: Record<string, unknown> }> } } } };
  const replayVcf = variantReplay.manifest.snapshot.provides.resources.find((resource) => resource.id === "case_vcf_raw");
  assert.equal(replayVcf?.params.region, "17:43090000-43100000,5:1000-2000");
  assert.equal(replayVcf?.params.sourceVersion, localCandidateVariantSearchRuntime(exampleDir).sourceVersion);

  const analysisDb = await openBioStore(exampleDir, { path: out.analysisDbPath });
  try {
    const rows = await analysisDb.conn.all<{ assessed: bigint; packet_rows: bigint; ranked: bigint; hypotheses: bigint }>(
      `SELECT
        (SELECT count(*) FROM variant_assessment) AS assessed,
        (SELECT count(*) FROM case_evidence) AS packet_rows,
        (SELECT count(*) FROM monarch_phenotype_hypotheses) AS ranked,
        (SELECT count(*) FROM phenotype_hypothesis) AS hypotheses`,
    );
    assert.deepEqual({
      assessed: Number(rows[0]?.assessed), packetRows: Number(rows[0]?.packet_rows),
      ranked: Number(rows[0]?.ranked), hypotheses: Number(rows[0]?.hypotheses),
    }, { assessed: 8, packetRows: 6, ranked: 2, hypotheses: 2 });
  } finally {
    analysisDb.close();
  }

  for (const runId of out.packet.provenance.runIds) {
    const files = (await fs.readdir(join(exampleDir, ".pi", "bio-agent", "runs", runId))).sort();
    assert.deepEqual(files, ["cas-refs.json", "run.json"], "lean mode keeps evidence in CAS rather than JSON exports");
  }

  const store = await openBioStore(exampleDir);
  try {
    const checkpoints = await store.conn.all<{ value_json: string }>(
      "SELECT value_json FROM bio_observations WHERE subject_id = ? AND predicate = 'job_step_checkpoint' ORDER BY statement_key",
      [`job:${out.analysisId}`],
    );
    assert.equal(checkpoints.length, 8);
    assert.ok(checkpoints.every((row) => {
      const envelope = JSON.parse(row.value_json) as { value: Record<string, unknown> };
      return !("rows" in envelope.value) && !("packet" in envelope.value);
    }), "checkpoint rows carry only CAS references and task metadata");

    const observations = await store.conn.all<{ subject_id: string; predicate: string; object_id: string | null }>(
      "SELECT subject_id, predicate, object_id FROM bio_observations WHERE subject_id IN (?, ?, ?) ORDER BY subject_id, predicate, object_id",
      [`case:${out.packet.caseId}`, `analysis:${out.analysisId}`, out.packetUri],
    );
    assert.ok(observations.some((row) => row.subject_id === `case:${out.packet.caseId}` && row.predicate === "has_analysis" && row.object_id === `analysis:${out.analysisId}`));
    assert.ok(observations.some((row) => row.subject_id === `case:${out.packet.caseId}` && row.predicate === "has_grounding" && row.object_id === out.packet.grounding.groundingId));
    assert.ok(observations.some((row) => row.subject_id === `analysis:${out.analysisId}` && row.predicate === "produces" && row.object_id === out.packetUri));
    assert.ok(observations.some((row) => row.subject_id === `analysis:${out.analysisId}` && row.predicate === "uses_grounding" && row.object_id === out.packet.grounding.groundingId));
    assert.ok(observations.some((row) => row.subject_id === out.packetUri && row.predicate === "derived_from" && row.object_id === out.packet.grounding.resultUri));
    for (const runId of out.packet.provenance.runIds) {
      assert.ok(observations.some((row) => row.subject_id === `analysis:${out.analysisId}` && row.predicate === "uses_run" && row.object_id === `run:${runId}`));
      assert.ok(observations.some((row) => row.subject_id === out.packetUri && row.predicate === "derived_from" && row.object_id === `run:${runId}`));
    }
    const runLinks = await store.conn.all<{ predicate: string; object_id: string | null }>(
      "SELECT predicate, object_id FROM bio_observations WHERE subject_id = ? ORDER BY predicate, object_id",
      [`run:${out.packet.lanes.inverted.runId}`],
    );
    assert.ok(runLinks.some((row) => row.predicate === "uses_run" && row.object_id === `run:${out.packet.stages.hypotheses.runId}`));
    assert.ok(runLinks.some((row) => row.predicate === "uses_run" && row.object_id === `run:${out.packet.stages.variantSearch.runId}`));
    const intervalLinks = await store.conn.all<{ predicate: string; object_id: string | null }>(
      "SELECT predicate, object_id FROM bio_observations WHERE subject_id = ? ORDER BY predicate, object_id",
      [`run:${out.packet.stages.intervals.runId}`],
    );
    assert.ok(intervalLinks.some((row) => row.predicate === "uses_run" && row.object_id === `run:${out.packet.stages.hypotheses.runId}`));
    const searchLinks = await store.conn.all<{ predicate: string; object_id: string | null }>(
      "SELECT predicate, object_id FROM bio_observations WHERE subject_id = ? ORDER BY predicate, object_id",
      [`run:${out.packet.stages.variantSearch.runId}`],
    );
    assert.ok(searchLinks.some((row) => row.predicate === "uses_run" && row.object_id === `run:${out.packet.stages.intervals.runId}`));
    const groundingRoots = await store.conn.all<{ digest: string }>(
      "SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'artifact'",
      [out.packet.grounding.groundingId],
    );
    assert.deepEqual(groundingRoots.map(({ digest }) => `sha256:${digest}`), [out.packet.grounding.resultDigest]);
  } finally {
    store.close();
  }
});
