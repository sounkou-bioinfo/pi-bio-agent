import type { JobRunner, JobResult, JobStatus, JobSubmitSpec } from "../core/jobs.js";
import type { RunReplaySpec } from "../core/reproducibility.js";

// The in-memory JobRunner — the second impl of the port from day one (the mocking case + the reference executor).
// It runs a job's work via an injected `execute` (the host says HOW to run a replay spec — e.g. re-drive
// runBioQueryFromManifest), so the runner itself stays agnostic to what a job computes. Faithful to the port:
// `submit` returns once the job is ACCEPTED (phase -> running), the work runs in the background, and `settle`
// (test-only) awaits it. A real host swaps this for a queue / worker pool / ducknng topology; nothing else changes.

export interface JobExecuteResult {
  result?: JobResult["result"];
  artifacts?: JobResult["artifacts"];
}

export interface InMemoryJobRunnerDeps {
  execute: (replay: RunReplaySpec) => Promise<JobExecuteResult>;
  /** injected clock for deterministic, strictly-increasing transition timestamps. */
  clock: () => string;
}

/** A JobRunner plus a test-only `settle(runId)` that awaits the background work (for deterministic assertions). */
export type InMemoryJobRunner = JobRunner & { settle(runId: string): Promise<void> };

export function inMemoryJobRunner(deps: InMemoryJobRunnerDeps): InMemoryJobRunner {
  interface Entry { status: JobStatus; result?: JobResult; done: Promise<void>; }
  const jobs = new Map<string, Entry>();

  return {
    async submit(spec: JobSubmitSpec): Promise<void> {
      if (jobs.has(spec.runId)) throw new Error(`in-memory job runner: job '${spec.runId}' already submitted`);
      const entry: Entry = { status: { runId: spec.runId, phase: "running", at: deps.clock() }, done: Promise.resolve() };
      jobs.set(spec.runId, entry);
      // run the work in the background; submit resolves now (job accepted), not on completion.
      entry.done = (async () => {
        try {
          const out = await deps.execute(spec.replay);
          entry.status = { runId: spec.runId, phase: "succeeded", at: deps.clock() };
          entry.result = { runId: spec.runId, phase: "succeeded", result: out.result, artifacts: out.artifacts };
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          entry.status = { runId: spec.runId, phase: "failed", at: deps.clock() };
          entry.result = { runId: spec.runId, phase: "failed", error };
        }
      })();
    },
    async status(runId: string): Promise<JobStatus | null> {
      return jobs.get(runId)?.status ?? null;
    },
    async collect(runId: string): Promise<JobResult | null> {
      return jobs.get(runId)?.result ?? null;
    },
    async settle(runId: string): Promise<void> {
      await jobs.get(runId)?.done;
    },
  };
}
