import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, test } from "node:test";

const execFileAsync = promisify(execFile);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

describe("SDK host embedding dogfood", () => {
  test("runs a host-composed query with injected DuckDB, CAS, compute, policy, receipts, and CAS metadata", { timeout: 20_000 }, async () => {
    const { stdout } = await execFileAsync(npmCmd, ["run", "dogfood:sdk-host-embedding"], {
      cwd: process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
    });
    const jsonStart = stdout.indexOf("{\n  \"dogfood\": \"sdk-host-embedding\"");
    assert.notEqual(jsonStart, -1, stdout);
    const summary = JSON.parse(stdout.slice(jsonStart)) as {
      dogfood: string;
      ok: boolean;
      publicImport: string;
      hostInjected: Record<string, unknown>;
      run: {
        runId: string;
        rowCount: number;
        artifactRows: number;
        artifactDigestCount: number;
        casRefs: number;
        casObjects: number;
        runFacts: number;
        hostReceiptDigests: string[];
      };
      policy: { statementsSeen: number; sawFinalQuery: boolean };
    };

    assert.equal(summary.dogfood, "sdk-host-embedding");
    assert.equal(summary.ok, true);
    assert.equal(summary.publicImport, "pi-bio-agent");
    assert.deepEqual(summary.hostInjected, {
      sqlConn: "duckdbNodeConn",
      casStore: "fsCasStore",
      computeRunner: "nodeComputeRunner",
      sqlPolicy: true,
      hostCapabilityReceipts: 1,
      casMetadata: true,
    });
    assert.equal(summary.run.runId, "sdk-host-embedding");
    assert.equal(summary.run.rowCount, 2);
    assert.equal(summary.run.artifactRows, 2);
    assert.equal(summary.run.artifactDigestCount, 2);
    assert.ok(summary.run.casRefs >= 3);
    assert.ok(summary.run.casObjects >= summary.run.casRefs);
    assert.equal(summary.run.runFacts, 1);
    assert.deepEqual(summary.run.hostReceiptDigests, [`sha256:${"7".repeat(64)}`]);
    assert.ok(summary.policy.statementsSeen > 0);
    assert.equal(summary.policy.sawFinalQuery, true);
  });
});
