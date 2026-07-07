import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, test } from "node:test";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

describe("bring-it-home dogfood command", () => {
  test("composes host events, checkpoints, graph projection, ducknng profile receipts, and SDK exports", { timeout: 20_000 }, async () => {
    const { stdout } = await execFileAsync(npmCmd, ["run", "dogfood:bring-it-home"], {
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    const jsonStart = stdout.indexOf("{\n  \"dogfood\": \"bring-it-home\"");
    assert.notEqual(jsonStart, -1, stdout);
    const summary = JSON.parse(stdout.slice(jsonStart)) as {
      dogfood: string;
      hostEventLinks: number;
      jobStepExecutions: { extract: number; score: number; firstExecuted: number; resumedExecuted: number; resumedReused: number; extractReused: boolean };
      checkpointKey: string;
      ducknngProfileReceipt: { subjectRestriction: { restricted: boolean; count: number; digest?: string } };
      hostCapabilityRun: { casMetadataRefs: number };
      renvEnvironment: { digest: string; packages: number; rVersion: string | null; bioconductor: string | null; envStatus: string; artifactRows: number };
      externalProjection: { edgeCount: number; closureCount: number };
      internalProjection: { edgesTable: string; edgeCount: number; closureTable: string; closureCount: number };
      trainingCorpus: { digest: string; redaction: string; units: number; toolCalls: number; runs: number; hostEvents: number; parquetReadbackRows: number; unitsParquetDigest: string };
      sdkConsumer: { publicExportsOnly: boolean; runtimeImports: boolean; packageSource: string; imports: string[] };
      observationCounts: Record<string, number>;
    };

    assert.equal(summary.dogfood, "bring-it-home");
    assert.equal(summary.hostEventLinks, 2);
    assert.deepEqual(summary.jobStepExecutions, { extract: 1, score: 1, firstExecuted: 1, resumedExecuted: 1, resumedReused: 1, extractReused: true });
    assert.equal(summary.checkpointKey, "job:dogfood-workflow:step:extract%2Fvariants");
    assert.equal(summary.ducknngProfileReceipt.subjectRestriction.restricted, true);
    assert.equal(summary.ducknngProfileReceipt.subjectRestriction.count, 2);
    assert.match(summary.ducknngProfileReceipt.subjectRestriction.digest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.ok(summary.hostCapabilityRun.casMetadataRefs >= 3);
    assert.match(summary.renvEnvironment.digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual({
      packages: summary.renvEnvironment.packages,
      rVersion: summary.renvEnvironment.rVersion,
      bioconductor: summary.renvEnvironment.bioconductor,
      envStatus: summary.renvEnvironment.envStatus,
      artifactRows: summary.renvEnvironment.artifactRows,
    }, { packages: 2, rVersion: "4.6.0", bioconductor: "3.22", envStatus: "matched", artifactRows: 1 });
    assert.deepEqual(summary.externalProjection, { edgesTable: "dogfood_external_edges", edgeCount: 3, closureTable: "dogfood_external_entailed", closureCount: 3 });
    assert.equal(summary.internalProjection.edgesTable, "dogfood_internal_edges");
    assert.equal(summary.internalProjection.closureTable, "dogfood_internal_entailed");
    assert.ok(summary.internalProjection.edgeCount >= 4);
    assert.ok(summary.internalProjection.closureCount >= 3);
    assert.match(summary.trainingCorpus.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(summary.trainingCorpus.redaction, "digest_only");
    assert.deepEqual({
      units: summary.trainingCorpus.units,
      toolCalls: summary.trainingCorpus.toolCalls,
      runs: summary.trainingCorpus.runs,
      hostEvents: summary.trainingCorpus.hostEvents,
      parquetReadbackRows: summary.trainingCorpus.parquetReadbackRows,
    }, { units: 1, toolCalls: 1, runs: 2, hostEvents: 1, parquetReadbackRows: 1 });
    assert.match(summary.trainingCorpus.unitsParquetDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(summary.sdkConsumer, { publicExportsOnly: true, runtimeImports: true, packageSource: "npm-pack", imports: ["pi-bio-agent", "pi-bio-agent/core", "pi-bio-agent/duckdb", "pi-bio-agent/hosts"] });
    assert.equal(summary.observationCounts.host_event, 1);
    assert.equal(summary.observationCounts.job_step_checkpoint, 2);
    assert.equal(summary.observationCounts.ducknng_http_profile_receipt, 1);
  });
});
