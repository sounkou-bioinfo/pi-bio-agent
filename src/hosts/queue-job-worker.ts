import type { JsonValue } from "../core/json.js";
import type { JobArtifactRef, JobPhase } from "../core/jobs.js";
import type { RunReplaySpec } from "../core/reproducibility.js";
import type { SqlConn } from "../core/ports.js";
import { observationAsOfKey } from "../duckdb/observations.js";
import {
  JobClaimLostError,
  claimJob,
  finishJobClaim,
  heartbeatJobClaim,
  recordJobClaimResult,
  recordJobClaimStatus,
} from "./job-queue.js";

const FUTURE = "9999-12-31T23:59:59.999Z";
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set(["succeeded", "failed", "cancelled"]);
const MAX_WORKER_ID_BYTES = 128;
const DEFAULT_ERROR_BYTES = 2_048;
const DEFAULT_ERROR_MESSAGE = "job execution failed";

export type QueueJobExecutorErrorContext = {
  runId: string;
  attempt: number;
  workerId: string;
  replayDigest: string;
};

type JobTerminalPhase = "succeeded" | "failed" | "cancelled";

export interface QueueJobExecutorResult {
  result?: JsonValue;
  artifacts?: JobArtifactRef[];
}

export type QueueJobExecutor = (replay: RunReplaySpec, signal: AbortSignal) => Promise<QueueJobExecutorResult>;

export interface QueueJobWorkerDeps {
  clock: () => string;
  workerId: string;
  leaseSeconds: number;
  /** Heartbeat interval in milliseconds. Must be positive and strictly less than `leaseSeconds * 1000`. */
  heartbeatMs?: number;
  source?: string;
  /** Optional redaction hook for durable error messaging. Non-string or throwing callbacks fall back to generic output. */
  errorFormatter?: (error: unknown, context: QueueJobExecutorErrorContext) => string;
  executor: QueueJobExecutor;
}

export interface QueueJobWorker {
  /** Claim and process at most one queued job. Returns `true` when one claim was handled. */
  runOne(signal?: AbortSignal): Promise<boolean>;
  /** Repeatedly claim and process until `signal` is aborted. */
  runLoop(options?: { signal?: AbortSignal; idleMs?: number }): Promise<void>;
}

const waitForEither = (ms: number, signal: AbortSignal): Promise<boolean> => {
  if (signal.aborted) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
};

function isTerminal(phase: JobPhase): phase is JobTerminalPhase {
  return TERMINAL_PHASES.has(phase);
}

function clampUtf8(input: string, maxBytes: number): string {
  if (input.length === 0 || Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  if (maxBytes <= 0) return "";
  let end = 0;
  let bytes = 0;
  for (const segment of input) {
    const encoded = Buffer.byteLength(segment, "utf8");
    if (bytes + encoded > maxBytes) break;
    bytes += encoded;
    end += segment.length;
  }
  return input.slice(0, end);
}

function sanitizeExecutionError(
  error: unknown,
  formatter: QueueJobWorkerDeps["errorFormatter"],
  context: QueueJobExecutorErrorContext,
): string {
  if (formatter) {
    try {
      const formatted = formatter(error, context);
      if (typeof formatted === "string") {
        const trimmed = formatted.trim();
        if (trimmed.length > 0) return clampUtf8(trimmed, DEFAULT_ERROR_BYTES);
      }
    } catch {
      // Fall through to generic disclosure for invalid formatter behavior.
    }
  }
  return clampUtf8(DEFAULT_ERROR_MESSAGE, DEFAULT_ERROR_BYTES);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as Error & { code?: unknown }).code === "ABORT_ERR");
}

function parseStatus(valueJson: string | null): JobPhase | undefined {
  if (valueJson == null) return undefined;
  const value = JSON.parse(valueJson) as unknown;
  const phase =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? (value as { phase?: unknown }).phase
        : undefined;
  if (
    phase === "queued" || phase === "running" || phase === "waiting" || phase === "succeeded" || phase === "failed" || phase === "cancelled"
  ) {
    return phase;
  }
  return undefined;
}

function validateDeps(deps: QueueJobWorkerDeps): void {
  if (typeof deps.workerId !== "string" || deps.workerId.length === 0 || deps.workerId.trim() !== deps.workerId || Buffer.byteLength(deps.workerId, "utf8") > MAX_WORKER_ID_BYTES) {
    throw new Error("queue-job-worker: workerId must be a non-empty trimmed string no longer than 128 UTF-8 bytes");
  }
  if (!Number.isInteger(deps.leaseSeconds) || deps.leaseSeconds <= 0 || deps.leaseSeconds > 86_400) {
    throw new Error("queue-job-worker: leaseSeconds must be a positive integer no larger than 86400");
  }
  const heartbeatMs = deps.heartbeatMs ?? Math.floor((deps.leaseSeconds * 1000) / 2);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= deps.leaseSeconds * 1000) {
    throw new Error("queue-job-worker: heartbeatMs must be positive and strictly less than leaseSeconds * 1000");
  }
}

async function safeWrite(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    if (error instanceof JobClaimLostError) return false;
    throw error;
  }
}

export function createQueueJobWorker(conn: SqlConn, deps: QueueJobWorkerDeps): QueueJobWorker {
  validateDeps(deps);
  const heartbeatMs = deps.heartbeatMs ?? Math.floor((deps.leaseSeconds * 1000) / 2);

  const terminalPhaseFor = async (runId: string, replayDigest: string): Promise<JobTerminalPhase | undefined> => {
    const status = await observationAsOfKey(conn, `job:${runId}:status`, FUTURE);
    if (!status || status.digest !== replayDigest) return undefined;
    const phase = parseStatus(status.value_json);
    if (!phase || !isTerminal(phase)) return undefined;
    const result = await observationAsOfKey(conn, `job:${runId}:result`, FUTURE);
    if (!result || result.digest !== replayDigest) return undefined;
    return phase;
  };

  const finishRecovered = async (claimRunId: string, phase: JobTerminalPhase): Promise<void> => {
    try {
      await finishJobClaim(conn, {
        runId: claimRunId,
        workerId: deps.workerId,
        now: deps.clock(),
        phase,
      });
    } catch (error) {
      if (!(error instanceof JobClaimLostError)) throw error;
      // stale reclaim/terminal race; safe to ignore.
    }
  };

  type JobClaim = NonNullable<Awaited<ReturnType<typeof claimJob>>>;
  const runClaimed = async (claim: JobClaim, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return;

    const execution = new AbortController();
    let abandonAttempt = false;
    const onAbort = signal
      ? () => {
          abandonAttempt = true;
          if (!execution.signal.aborted) execution.abort(signal.reason);
        }
      : undefined;

    if (onAbort && signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    try {
      try {
        await recordJobClaimStatus(conn, {
          runId: claim.runId,
          workerId: deps.workerId,
          attempt: claim.attempt,
          replayDigest: claim.replayDigest,
          source: deps.source,
          phase: "running",
          recordedAt: deps.clock(),
          message: "running",
        });
      } catch (error) {
        if (error instanceof JobClaimLostError) return;
        throw error;
      }
      if (abandonAttempt || signal?.aborted) return;

      const heartbeat = (async () => {
        while (!abandonAttempt) {
          const aborted = await waitForEither(heartbeatMs, execution.signal);
          if (aborted || abandonAttempt) return;
          try {
            await heartbeatJobClaim(conn, {
              runId: claim.runId,
              workerId: deps.workerId,
              now: deps.clock(),
              leaseSeconds: deps.leaseSeconds,
            });
          } catch (error) {
            if (!abandonAttempt) {
              abandonAttempt = true;
              if (!execution.signal.aborted) execution.abort(error instanceof Error ? error : new Error(String(error)));
            }
            return;
          }
        }
      })();

      let result: QueueJobExecutorResult | undefined;
      let error: unknown;
      try {
        result = await deps.executor(claim.replay, execution.signal);
      } catch (exc) {
        error = exc;
        if (isAbortError(exc)) {
          abandonAttempt = true;
          if (!execution.signal.aborted) execution.abort(exc);
        }
      }

      if (!execution.signal.aborted) execution.abort();
      await heartbeat;

      if (abandonAttempt) return;

      if (error) {
        const message = sanitizeExecutionError(error, deps.errorFormatter, {
          runId: claim.runId,
          attempt: claim.attempt,
          workerId: deps.workerId,
          replayDigest: claim.replayDigest,
        });
        const wroteResult = await safeWrite(() => recordJobClaimResult(conn, {
          runId: claim.runId,
          workerId: deps.workerId,
          attempt: claim.attempt,
          replayDigest: claim.replayDigest,
          recordedAt: deps.clock(),
          error: message,
        }));
        if (!wroteResult) return;

        const wroteStatus = await safeWrite(() => recordJobClaimStatus(conn, {
          runId: claim.runId,
          workerId: deps.workerId,
          attempt: claim.attempt,
          replayDigest: claim.replayDigest,
          source: deps.source,
          phase: "failed",
          recordedAt: deps.clock(),
          message,
        }));
        if (!wroteStatus) return;

        await safeWrite(() => finishJobClaim(conn, {
          runId: claim.runId,
          workerId: deps.workerId,
          now: deps.clock(),
          phase: "failed",
        }));
        return;
      }

      const wroteResult = await safeWrite(() => recordJobClaimResult(conn, {
        runId: claim.runId,
        workerId: deps.workerId,
        attempt: claim.attempt,
        replayDigest: claim.replayDigest,
        recordedAt: deps.clock(),
        result: result?.result,
        artifacts: result?.artifacts,
      }));
      if (!wroteResult) return;

      const wroteStatus = await safeWrite(() => recordJobClaimStatus(conn, {
        runId: claim.runId,
        workerId: deps.workerId,
        attempt: claim.attempt,
        replayDigest: claim.replayDigest,
        source: deps.source,
        phase: "succeeded",
        recordedAt: deps.clock(),
      }));
      if (!wroteStatus) return;

      await safeWrite(() => finishJobClaim(conn, {
        runId: claim.runId,
        workerId: deps.workerId,
        now: deps.clock(),
        phase: "succeeded",
      }));
    } finally {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    }
  };

  const runOne = async (signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return false;
    const claim = await claimJob(conn, {
      workerId: deps.workerId,
      now: deps.clock(),
      leaseSeconds: deps.leaseSeconds,
    });
    if (!claim) return false;

    const terminal = await terminalPhaseFor(claim.runId, claim.replayDigest);
    if (terminal) {
      await finishRecovered(claim.runId, terminal);
      return true;
    }

    await runClaimed(claim, signal);
    return true;
  };

  return {
    runOne,
    async runLoop(options: { signal?: AbortSignal; idleMs?: number } = {}): Promise<void> {
      const signal = options.signal ?? new AbortController().signal;
      const idleMs = options.idleMs ?? 50;
      if (!Number.isInteger(idleMs) || idleMs < 0) {
        throw new Error("queue-job-worker: idleMs must be a non-negative integer");
      }
      while (!signal.aborted) {
        const worked = await runOne(signal);
        if (signal.aborted) return;
        if (!worked) {
          const aborted = await waitForEither(idleMs, signal);
          if (aborted) return;
        }
      }
    },
  };
}
