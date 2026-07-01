import type { SqlConn } from "../core/ports.js";
import { assertJobReplay, type JobRunner, type JobStatus, type JobResult, type JobPhase, type JobSubmitSpec } from "../core/jobs.js";
import { observationAsOfKey } from "../duckdb/observations.js";

// The DISTRIBUTED JobRunner (L1's second real impl). Where the in-memory runner holds status in process memory,
// this runner's status/result live in the SHARED observation ledger: a remote worker — any language, over any
// transport — reports its phase into the `job:<runId>:status` slot (e.g. via ducknng RPC, see
// scripts/nng-job-runner.mjs), and the runner just READS it. `submit` only DISPATCHES the job; the worker owns
// execution + reporting. Because status is data-in-SQL, not process memory, a job survives a restart and crosses
// machines/languages, and this runner drops into the job-store UNCHANGED (pollBioJob sees the worker's already-
// recorded phase and, since it is unchanged, does not double-record).

const FUTURE = "9999-12-31T23:59:59.999Z";
const PHASES = new Set<JobPhase>(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const isTerminal = (p: JobPhase): boolean => p === "succeeded" || p === "failed" || p === "cancelled";

/** The one transport-specific seam: how a host SENDS a job to a worker — ducknng NNG push/pull, an SSH submit, a
 *  Modal call, a local spawn. Injected so the runner stays transport-agnostic (accept interfaces). */
export type JobDispatch = (spec: JobSubmitSpec) => Promise<void>;

export function ledgerJobRunner(conn: SqlConn, dispatch: JobDispatch): JobRunner {
  const statusSlot = (runId: string): string => `job:${runId}:status`;
  const resultSlot = (runId: string): string => `job:${runId}:result`;

  const readStatus = async (runId: string): Promise<JobStatus | null> => {
    const row = await observationAsOfKey(conn, statusSlot(runId), FUTURE);
    if (row?.value_json == null) return null;
    // a worker may record either a bare phase ("succeeded") or a richer {phase, message, progress} object
    const v = JSON.parse(row.value_json) as unknown;
    const rec = (typeof v === "object" && v !== null ? v : { phase: v }) as { phase?: unknown; message?: string; progress?: JobStatus["progress"] };
    if (typeof rec.phase !== "string" || !PHASES.has(rec.phase as JobPhase)) {
      throw new Error(`ledgerJobRunner: job '${runId}' has an invalid status phase ${JSON.stringify(rec.phase)}`);
    }
    return { runId, phase: rec.phase as JobPhase, at: row.recorded_at, message: rec.message, progress: rec.progress };
  };

  return {
    async submit(spec: JobSubmitSpec): Promise<void> {
      assertJobReplay(spec.runId, spec.replay); // fail closed at the boundary
      await dispatch(spec); // hand the job to the worker pool; the worker reports status into the shared slot
    },
    status: readStatus,
    async collect(runId: string): Promise<JobResult | null> {
      const st = await readStatus(runId);
      if (!st || !isTerminal(st.phase)) return null; // not done yet
      if (st.phase === "failed") return { runId, phase: "failed", error: st.message ?? "job failed" };
      if (st.phase === "cancelled") return { runId, phase: "cancelled" };
      const row = await observationAsOfKey(conn, resultSlot(runId), FUTURE); // a succeeded worker records its result handle here
      return { runId, phase: "succeeded", result: row?.value_json != null ? JSON.parse(row.value_json) : undefined };
    },
  };
}
