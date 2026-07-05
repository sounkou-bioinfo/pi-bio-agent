import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBioStore } from "pi-bio-agent";
import { runClinicalGenomicsWorkbench } from "../src/clinical-genomics.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-clinical-"));
  await fs.cp(fixtureRoot, dir, { recursive: true });
  await fs.rm(join(dir, ".pi"), { recursive: true, force: true });
  return dir;
}

test("clinical workbench runs direct and inverted lanes into one evidence packet", async () => {
  const exampleDir = await copyFixture();
  const out = await runClinicalGenomicsWorkbench({ exampleDir, caseId: "CASE-RD-001", now: "2026-07-05T12:00:00Z" });

  assert.equal(out.runs.length, 3);
  assert.equal(out.packet.schema, "pi-bio.workbench.evidence_packet.v1");
  assert.equal(out.packet.summary.kernelScope, "evidence-routing only; not a complete ACMG/AMP classifier");
  assert.equal(out.packet.summary.directCandidates, 1);
  assert.equal(out.packet.summary.directAbstentions, 1);
  assert.equal(out.packet.summary.invertedSupportedHypotheses, 1);
  assert.equal(out.packet.summary.invertedGaps, 1);
  assert.equal(out.packet.summary.reanalysisSignals, 1);

  const direct = out.packet.lanes.direct.rows;
  assert.equal(direct.find((r) => r.variant_key === "17-43093464-A-T")?.evidence_status, "curated_plp_candidate");
  assert.equal(direct.find((r) => r.variant_key === "2-47637258-C-CT")?.bucket, "abstain_no_frequency");

  const inverted = out.packet.lanes.inverted.rows;
  assert.ok(inverted.some((r) => r.gene === "GENEB" && r.hypothesis_bucket === "genotype_supports_hypothesis"));
  assert.ok(inverted.some((r) => r.gene === "GENEH" && r.hypothesis_bucket === "hypothesis_without_variant"));

  assert.ok(out.packet.summary.reviewQueue.some((r) => r.kind === "resolve_frequency" && r.target === "variant:2-47637258-C-CT"));
});

test("evidence packet is recorded as CAS artifact and linked to scientific runs", async () => {
  const exampleDir = await copyFixture();
  const out = await runClinicalGenomicsWorkbench({ exampleDir, caseId: "CASE-RD-001", now: "2026-07-05T12:00:00Z" });
  const store = await openBioStore(exampleDir);
  try {
    const obs = await store.conn.all<{ predicate: string; value_json: string | null }>(
      "SELECT predicate, value_json FROM bio_observations WHERE subject_id = ? ORDER BY predicate",
      ["case:CASE-RD-001"],
    );
    assert.ok(obs.some((r) => r.predicate === "evidence_packet"));
    assert.ok(obs.some((r) => r.predicate === "produces"));
    assert.equal(obs.find((r) => r.predicate === "evidence_packet")?.value_json?.includes(out.packetDigest), true);

    const runFacts = await store.conn.all<{ n: bigint }>("SELECT count(*) AS n FROM bio_observations WHERE starts_with(subject_id, 'run:') AND predicate = 'run'");
    assert.equal(Number(runFacts[0].n), 3);

    const links = await store.conn.all<{ subject_id: string; predicate: string; object_id: string | null }>(
      "SELECT subject_id, predicate, object_id FROM bio_observations WHERE predicate IN ('uses_run', 'derived_from')",
    );
    for (const run of out.runs) {
      assert.ok(links.some((r) => r.subject_id === "case:CASE-RD-001" && r.predicate === "uses_run" && r.object_id === `run:${run.runId}`));
      assert.ok(links.some((r) => r.subject_id === out.packetUri && r.predicate === "derived_from" && r.object_id === `run:${run.runId}`));
    }

    const digest = out.packetDigest.slice("sha256:".length);
    await fs.access(join(exampleDir, ".pi", "bio-agent", "cas", "sha256", digest));
  } finally {
    store.close();
  }
});
