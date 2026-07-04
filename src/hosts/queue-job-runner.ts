import type { JobResult, JobRunner, JobStatus, JobSubmitSpec } from "../core/jobs.js";
import { assertJobReplay } from "../core/jobs.js";
import type { SqlConn } from "../core/ports.js";
import { cancelQueuedJob, enqueueJob, readJobQueueRecord } from "./job-queue.js";
import { ledgerJobRunner } from "./ledger-job-runner.js";

// A JobRunner backed by the durable queue. `submit` only enqueues; workers claim through hosts/job-queue.ts and
// report status/result into the observation ledger. Status prefers the ledger (audit truth) and falls back to the
// queue's operational phase before any worker has reported.

export interface QueueJobRunnerDeps {
  clock: () => string;
}

export function queueJobRunner(conn: SqlConn, deps: QueueJobRunnerDeps): JobRunner {
  const ledger = ledgerJobRunner(conn, async () => {});

  const statusFromQueue = async (runId: string): Promise<JobStatus | null> => {
    const rec = await readJobQueueRecord(conn, runId);
    return rec ? { runId, phase: rec.phase, at: rec.updatedAt } : null;
  };

  return {
    async submit(spec: JobSubmitSpec): Promise<string> {
      assertJobReplay(spec.runId, spec.replay);
      const now = deps.clock();
      await enqueueJob(conn, { runId: spec.runId, replay: spec.replay, now });
      return spec.runId;
    },
    async status(runId: string): Promise<JobStatus | null> {
      return (await ledger.status(runId)) ?? (await statusFromQueue(runId));
    },
    async collect(runId: string): Promise<JobResult | null> {
      const durable = await ledger.collect(runId);
      if (durable) return durable;
      const rec = await readJobQueueRecord(conn, runId);
      if (!rec) return null;
      if (rec.phase === "cancelled") return { runId, phase: "cancelled" };
      if (rec.phase === "failed") return { runId, phase: "failed", error: "job failed" };
      return null;
    },
    async cancel(runId: string): Promise<void> {
      await cancelQueuedJob(conn, { runId, now: deps.clock() });
    },
  };
}
