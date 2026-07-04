import { assertJobReplay, type JobRunner, type JobResult, type JobStatus, type JobSubmitSpec } from "../core/jobs.js";
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
  interface Entry { status: JobStatus; result?: JobResult; done: Promise<void>; cancelled: boolean; }
  const jobs = new Map<string, Entry>();

  return {
    async submit(spec: JobSubmitSpec): Promise<string> {
      assertJobReplay(spec.runId, spec.replay); // fail closed at the runner boundary too
      if (jobs.has(spec.runId)) throw new Error(`in-memory job runner: job '${spec.runId}' already submitted`);
      // install a DEFERRED done before starting work, so settle() can never observe a placeholder promise
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((r) => { resolveDone = r; });
      const entry: Entry = { status: { runId: spec.runId, phase: "running", at: deps.clock() }, done, cancelled: false };
      jobs.set(spec.runId, entry);
      // run the work in the background; submit resolves now (job accepted), not on completion.
      void (async () => {
        try {
          const out = await deps.execute(spec.replay);
          if (entry.cancelled) return; // a cancel that landed mid-flight wins — don't overwrite it with the result
          entry.status = { runId: spec.runId, phase: "succeeded", at: deps.clock() };
          entry.result = { runId: spec.runId, phase: "succeeded", result: out.result, artifacts: out.artifacts };
        } catch (e) {
          if (entry.cancelled) return;
          const error = e instanceof Error ? e.message : String(e);
          entry.status = { runId: spec.runId, phase: "failed", at: deps.clock() };
          entry.result = { runId: spec.runId, phase: "failed", error };
        } finally {
          resolveDone();
        }
      })();
      return spec.runId;
    },
    async status(runId: string): Promise<JobStatus | null> {
      return jobs.get(runId)?.status ?? null;
    },
    async collect(runId: string): Promise<JobResult | null> {
      return jobs.get(runId)?.result ?? null;
    },
    async cancel(runId: string): Promise<void> {
      const entry = jobs.get(runId);
      if (!entry) throw new Error(`in-memory job runner: unknown job '${runId}'`);
      if (entry.status.phase === "succeeded" || entry.status.phase === "failed" || entry.status.phase === "cancelled") return; // terminal — nothing to cancel
      entry.cancelled = true;
      entry.status = { runId, phase: "cancelled", at: deps.clock() };
      entry.result = { runId, phase: "cancelled" };
    },
    async settle(runId: string): Promise<void> {
      const entry = jobs.get(runId);
      if (!entry) throw new Error(`in-memory job runner: unknown job '${runId}'`);
      await entry.done;
    },
  };
}
