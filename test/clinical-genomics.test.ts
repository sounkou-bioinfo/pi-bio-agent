import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBioStore, runBioOperationFromManifest } from "pi-bio-agent";
import {
  getClinicalAnalysis,
  readEvidencePacket,
  runClinicalGenomicsWorkbench,
} from "../src/clinical-genomics.js";
import { loadRecordedGroundingRuntime } from "../src/recorded-grounding.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-clinical-"));
  await fs.cp(fixtureRoot, dir, { recursive: true });
  await fs.rm(join(dir, ".pi"), { recursive: true, force: true });
  return dir;
}

async function runFixture(
  exampleDir: string,
  request: Omit<Parameters<typeof runClinicalGenomicsWorkbench>[0], "exampleDir" | "grounding">,
) {
  return runClinicalGenomicsWorkbench({
    ...request,
    exampleDir,
    grounding: await loadRecordedGroundingRuntime(join(exampleDir, "data", "grounding_proposals.json")),
  });
}

test("clinical workbench reconciles direct and inverted traversal into one evidence relation", async () => {
  const exampleDir = await copyFixture();
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-evidence",
    now: "2026-07-05T12:00:00Z",
  });

  assert.equal(out.workflow.executedSteps, 4);
  assert.equal(out.workflow.reusedSteps, 0);
  assert.equal(out.packet.schema, "pi-bio.workbench.evidence_packet.v1");
  assert.equal(out.packet.summary.kernelScope, "evidence routing only; not a complete clinical classification kernel");
  assert.equal(out.packet.summary.directCandidates, 1);
  assert.equal(out.packet.summary.directAbstentions, 1);
  assert.equal(out.packet.summary.invertedSupportedHypotheses, 1);
  assert.equal(out.packet.summary.invertedGaps, 1);
  assert.equal(out.packet.summary.conflicts, 1);
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
  assert.ok(inverted.some((row) => row.gene === "GENEB" && row.evidence_status === "genotype_supports_hypothesis"));
  assert.ok(inverted.some((row) => row.gene === "GENEH" && row.evidence_status === "hypothesis_without_supporting_variant"));
  assert.ok(out.packet.summary.reviewQueue.some((row) => row.kind === "resolve_frequency" && row.target === "variant:2-47637258-C-CT"));
});

test("inverted traversal retains every case variant for a phenotype-supported gene", async () => {
  const exampleDir = await copyFixture();
  await fs.appendFile(
    join(exampleDir, "data", "case_variants.csv"),
    "CASE-RD-001,17-43093465-G-A,GENEB,stop_gained,0.0001,Uncertain significance,het,inherited\n",
  );
  const out = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-multiple-variants",
    now: "2026-07-05T12:00:00Z",
  });
  const geneB = out.packet.lanes.inverted.rows.filter((row) => row.gene === "GENEB");
  assert.deepEqual(geneB.map((row) => row.variant_key).sort(), ["17-43093464-A-T", "17-43093465-G-A"]);
  assert.equal(out.packet.summary.invertedSupportedHypotheses, 1, "variant rows do not inflate hypothesis cardinality");
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
    out.packet.lanes.reanalysis.rows.find((row) => row.variant_key === "7-100-A-G")?.change_status,
    "abstain_unknown_status",
  );
});

test("the evidence operation rejects forged grounded observations", async () => {
  const exampleDir = await copyFixture();
  const response = await runBioOperationFromManifest({
    cwd: exampleDir,
    dbPath: join(exampleDir, "forged-grounding.duckdb"),
    manifestPath: "manifest.json",
    operationId: "clinical.case_evidence",
    bindings: { case_id: "CASE-RD-001" },
    protectedSessionBindings: {
      grounded_phenotypes_json: JSON.stringify([{
        caseId: "CASE-RD-001",
        hpoId: "HP:0001252",
        hpoLabel: "Hypotonia",
        assertionContext: "present",
        subjectContext: "proband",
        evidenceText: "hypotonia",
        startOffset: 45,
        endOffset: 54,
        sourceDigest: "sha256:forged",
        ontologySource: "HPO",
        ontologyVersion: "fixture-2026-07",
        ontologyDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        proposalId: "forged",
        proposalProvider: "forged",
        proposalModel: "forged",
        review: { decision: "approved", reviewer: "forged", proposalDigest: "forged", inputDigest: "forged" },
        acceptanceState: "accepted",
      }]),
    },
    protectedSessionVariables: ["grounded_phenotypes_json"],
  });
  assert.equal(response.ok, false);
  if (!response.ok) assert.match(response.error, /source digest mismatch/);
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

test("same analysis id resumes from all four durable checkpoints", async () => {
  const exampleDir = await copyFixture();
  const first = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-resume",
    now: "2026-07-05T12:00:00Z",
  });
  const resumed = await runFixture(exampleDir, {
    caseId: "CASE-RD-001",
    analysisId: "analysis-resume",
    now: "2026-07-05T12:05:00Z",
  });

  assert.equal(first.workflow.executedSteps, 4);
  assert.equal(resumed.workflow.executedSteps, 0);
  assert.equal(resumed.workflow.reusedSteps, 4);
  assert.equal(resumed.packetDigest, first.packetDigest);
  assert.equal(resumed.packet.generatedAt, "2026-07-05T12:00:00Z");

  const store = await openBioStore(exampleDir);
  try {
    const rows = await store.conn.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM bio_observations WHERE predicate = 'run' AND starts_with(subject_id, 'run:analysis-resume.')",
    );
    assert.equal(Number(rows[0]?.n), 5);
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

  const analysisDb = await openBioStore(exampleDir, { path: out.analysisDbPath });
  try {
    const rows = await analysisDb.conn.all<{ assessed: bigint; packet_rows: bigint; grounded: bigint; hypotheses: bigint }>(
      `SELECT
        (SELECT count(*) FROM variant_assessment) AS assessed,
        (SELECT count(*) FROM case_evidence) AS packet_rows,
        (SELECT count(*) FROM grounded_phenotype_observations) AS grounded,
        (SELECT count(*) FROM phenotype_hypothesis) AS hypotheses`,
    );
    assert.deepEqual({
      assessed: Number(rows[0]?.assessed), packetRows: Number(rows[0]?.packet_rows),
      grounded: Number(rows[0]?.grounded), hypotheses: Number(rows[0]?.hypotheses),
    }, { assessed: 5, packetRows: 5, grounded: 4, hypotheses: 2 });
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
    assert.equal(checkpoints.length, 4);
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
    const groundingRoots = await store.conn.all<{ digest: string }>(
      "SELECT digest FROM cas_ref WHERE ref_id = ? AND ref_type = 'artifact'",
      [out.packet.grounding.groundingId],
    );
    assert.deepEqual(groundingRoots.map(({ digest }) => `sha256:${digest}`), [out.packet.grounding.resultDigest]);
  } finally {
    store.close();
  }
});
