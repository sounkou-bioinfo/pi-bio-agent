import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema } from "../src/duckdb/observations.js";
import type { JsonValue } from "../src/core/json.js";
import { collectComputeTask } from "../src/core/ports.js";
import { runJobStepsWithCheckpoints } from "../src/hosts/job-store.js";
import { nodeComputeRunner } from "../src/process/node-compute-runner.js";

const REPLAY_DIGEST = `sha256:${"b".repeat(64)}`;

const PYTHON = (() => {
  const candidates = [process.env.PYTHON, "python3", "python"].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const exe of candidates) {
    try {
      execFileSync(exe, ["--version"], { stdio: "ignore" });
      return exe;
    } catch {
      /* try next candidate */
    }
  }
  return null;
})();

const PYTHON_STEP = `
import json
import sys

payload = json.loads(sys.argv[1])
kind = payload["kind"]

if kind == "extract":
    values = [1, 2, 3, 4, 5]
    print(json.dumps({"backend": "python", "rows": len(values), "sum": sum(values)}))
elif kind == "score":
    extract = payload["extract"]
    print(json.dumps({"backend": "python", "input_rows": extract["rows"], "score": extract["sum"] * 2}))
elif kind == "report":
    score = payload["score"]
    print(json.dumps({"backend": "python", "summary": f"{score['input_rows']} rows; score={score['score']}"}))
else:
    raise SystemExit(f"unknown step kind: {kind}")
`;

type JsonObject = { [key: string]: JsonValue };

async function pythonJson(cwd: string, payload: JsonObject): Promise<JsonObject> {
  const result = await collectComputeTask(nodeComputeRunner(), {
    command: [PYTHON!, "-c", PYTHON_STEP, JSON.stringify(payload)],
    cwd,
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.timedOut, false);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length > 0, "python step printed one JSON result line");
  const parsed = JSON.parse(lines.at(-1)!) as JsonValue;
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "python step returned a JSON object");
  return parsed;
}

describe("checkpointed workflow over Python compute", { skip: PYTHON ? false : "Python unavailable" }, () => {
  test("resumes a durable step plan and runs only missing Python-backed steps", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await createBioObservationSchema(conn);
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-python-workflow-"));
    let extractRuns = 0;
    let scoreRuns = 0;
    let reportRuns = 0;

    const first = await runJobStepsWithCheckpoints(conn, {
      runId: "python-workflow",
      recordedAt: "2026-07-08T00:00:01.000Z",
      replayDigest: REPLAY_DIGEST,
      attempt: 1,
      steps: [
        {
          stepId: "extract.python",
          run: async () => {
            extractRuns += 1;
            return await pythonJson(cwd, { kind: "extract" });
          },
        },
      ],
    });

    assert.equal(first.executed, 1);
    assert.equal(first.reused, 0);
    assert.deepEqual(first.steps.map((s) => [s.stepId, s.reused]), [["extract.python", false]]);

    const resumed = await runJobStepsWithCheckpoints(conn, {
      runId: "python-workflow",
      recordedAt: "2026-07-08T00:00:02.000Z",
      replayDigest: REPLAY_DIGEST,
      attempt: 2,
      steps: [
        {
          stepId: "extract.python",
          run: async () => {
            extractRuns += 1;
            throw new Error("completed Python prefix step was re-executed");
          },
        },
        {
          stepId: "score.python",
          run: async ({ valueOf }) => {
            scoreRuns += 1;
            return await pythonJson(cwd, { kind: "score", extract: valueOf("extract.python") });
          },
        },
        {
          stepId: "report.python",
          run: async ({ valueOf }) => {
            reportRuns += 1;
            return await pythonJson(cwd, { kind: "report", score: valueOf("score.python") });
          },
        },
      ],
    });

    assert.equal(resumed.executed, 2);
    assert.equal(resumed.reused, 1);
    assert.equal(extractRuns, 1, "completed prefix checkpoint was reused across attempts");
    assert.equal(scoreRuns, 1);
    assert.equal(reportRuns, 1);
    assert.deepEqual(resumed.steps.map((s) => [s.stepId, s.reused, s.value]), [
      ["extract.python", true, { backend: "python", rows: 5, sum: 15 }],
      ["score.python", false, { backend: "python", input_rows: 5, score: 30 }],
      ["report.python", false, { backend: "python", summary: "5 rows; score=30" }],
    ]);

    const rows = await conn.all<{ step_id: string; attempt: number; backend: string }>(
      `SELECT
         attrs->>'step_id' AS step_id,
         CAST(attrs->>'attempt' AS INTEGER) AS attempt,
         json_extract_string(value_json, '$.value.backend') AS backend
       FROM bio_observations
       WHERE subject_id = 'job:python-workflow' AND predicate = 'job_step_checkpoint'
       ORDER BY
         recorded_at::TIMESTAMPTZ,
         CASE attrs->>'step_id'
           WHEN 'extract.python' THEN 1
           WHEN 'score.python' THEN 2
           WHEN 'report.python' THEN 3
           ELSE 99
         END`,
    );
    assert.deepEqual(rows, [
      { step_id: "extract.python", attempt: 1, backend: "python" },
      { step_id: "score.python", attempt: 2, backend: "python" },
      { step_id: "report.python", attempt: 2, backend: "python" },
    ]);
  });
});
