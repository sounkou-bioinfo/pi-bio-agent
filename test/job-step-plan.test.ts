import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import {
  jobStepCheckpointKey,
  readJobStepCheckpoint,
  runJobStepsWithCheckpoints,
} from "../src/hosts/job-store.js";

const REPLAY_DIGEST = `sha256:${"a".repeat(64)}`;

async function conn() {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}

describe("runJobStepsWithCheckpoints", () => {
  test("resumes a sequential plan from durable checkpoints and runs only missing steps", async () => {
    const c = await conn();
    let extractRuns = 0;
    let scoreRuns = 0;
    let reportRuns = 0;

    const first = await runJobStepsWithCheckpoints(c, {
      runId: "workflow-resume",
      recordedAt: "2026-07-07T00:00:01.000Z",
      replayDigest: REPLAY_DIGEST,
      attempt: 1,
      steps: [
        {
          stepId: "extract/variants",
          run: () => {
            extractRuns += 1;
            return { rows: 5 };
          },
        },
      ],
    });

    assert.equal(first.executed, 1);
    assert.equal(first.reused, 0);
    assert.deepEqual((await readJobStepCheckpoint(c, "workflow-resume", "extract/variants"))?.value, { rows: 5 });

    const resumed = await runJobStepsWithCheckpoints(c, {
      runId: "workflow-resume",
      recordedAt: "2026-07-07T00:00:02.000Z",
      replayDigest: REPLAY_DIGEST,
      attempt: 2,
      steps: [
        {
          stepId: "extract/variants",
          run: () => {
            extractRuns += 1;
            return { rows: 99 };
          },
        },
        {
          stepId: "score/high-impact",
          run: ({ valueOf }) => {
            scoreRuns += 1;
            const extract = valueOf<{ rows: number }>("extract/variants");
            return { candidates: 2, inputRows: extract.rows };
          },
        },
        {
          stepId: "report",
          run: ({ valueOf }) => {
            reportRuns += 1;
            const score = valueOf<{ candidates: number; inputRows: number }>("score/high-impact");
            return { rendered: true, candidates: score.candidates, inputRows: score.inputRows };
          },
        },
      ],
    });

    assert.equal(resumed.executed, 2);
    assert.equal(resumed.reused, 1);
    assert.deepEqual(resumed.steps.map((s) => [s.stepId, s.reused]), [
      ["extract/variants", true],
      ["score/high-impact", false],
      ["report", false],
    ]);
    assert.equal(extractRuns, 1, "completed prefix step was not re-executed");
    assert.equal(scoreRuns, 1);
    assert.equal(reportRuns, 1);
    assert.deepEqual((await readJobStepCheckpoint(c, "workflow-resume", "report"))?.value, {
      rendered: true,
      candidates: 2,
      inputRows: 5,
    });
  });

  test("rejects invalid plans before writing partial checkpoints", async () => {
    const c = await conn();
    await assert.rejects(
      () => runJobStepsWithCheckpoints(c, {
        runId: "bad-plan",
        recordedAt: "2026-07-07T00:00:01.000Z",
        replayDigest: REPLAY_DIGEST,
        steps: [],
      }),
      /must contain at least one step/,
    );
    await assert.rejects(
      () => runJobStepsWithCheckpoints(c, {
        runId: "bad-plan",
        recordedAt: "2026-07-07T00:00:01.000Z",
        replayDigest: REPLAY_DIGEST,
        steps: [
          { stepId: "extract", run: () => ({ ok: true }) },
          { stepId: "extract", run: () => ({ ok: false }) },
        ],
      }),
      /duplicate checkpoint stepId 'extract'/,
    );

    assert.equal(await observationAsOfKey(c, jobStepCheckpointKey("bad-plan", "extract"), "9999-12-31T23:59:59.999Z"), null);
  });

  test("fails closed when a step asks for a future or missing checkpoint", async () => {
    const c = await conn();
    await assert.rejects(
      () => runJobStepsWithCheckpoints(c, {
        runId: "missing-upstream",
        recordedAt: "2026-07-07T00:00:01.000Z",
        replayDigest: REPLAY_DIGEST,
        steps: [
          {
            stepId: "score",
            run: ({ valueOf }) => valueOf("extract"),
          },
        ],
      }),
      /checkpoint step 'extract' has not completed/,
    );
  });
});
