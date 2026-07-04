import type { RunReplaySpec } from "./reproducibility.js";
import type { BioRunStatus } from "./run-spec.js";
import type { JsonValue } from "./json.js";
import type { AsyncRunner } from "./ports.js";

// L1 — the async/long-running lane. Bio work is minutes-to-hours (a whole-VCF annotation, an alignment, a
// cohort regression), so a run must be able to OUTLIVE the call that started it. A job is a run made DURABLE and
// ASYNC: it carries the RunReplaySpec (the actual replay inputs C2's reproduce() re-executes), so a worker can
// run it out-of-band AND it stays reproducible. Job status is the SAME temporal substrate as Phase 4: a
// `job:<runId>:status` observation slot, so "what was this job's status as of t" is an as-of query, not bespoke.
//
// This is the RUN-SPECIALIZED view of the same AsyncRunner primitive used by ComputeRunner. It exists because a
// replayable bio run has run-specific validation and ledger slots, not because jobs have a separate lifecycle. A
// real host can back it with hosts/job-queue.ts, an Absurd-style task/run/checkpoint table set, a worker pool, or a
// ducknng topology; all of those are durable AsyncRunner backends, not new core abstractions.

/** A run made durable+async. The replay spec is REQUIRED — a job you cannot reproduce is not a job (fail closed). */
export interface JobSubmitSpec {
  runId: string;
  replay: RunReplaySpec;
}

/** Fail-closed validation of a job's replay spec, enforced at BOTH boundaries (store submit + runner submit): a
 *  job must carry a well-formed RunReplaySpec whose runId matches the job's — an empty object, a wrong schema, or
 *  a mismatched runId is rejected before anything is recorded, digested, or executed. */
export function assertJobReplay(runId: string, replay: RunReplaySpec | undefined): asserts replay is RunReplaySpec {
  if (!replay || typeof replay !== "object" || Array.isArray(replay)) throw new Error("job: a RunReplaySpec is required (fail closed)");
  if (replay.schema !== "pi-bio.run_replay_spec.v1") throw new Error("job: replay.schema must be 'pi-bio.run_replay_spec.v1'");
  if (replay.kind !== "query" && replay.kind !== "operation" && replay.kind !== "compute.run") throw new Error(`job: replay.kind '${String(replay.kind)}' is invalid`);
  if (replay.runId !== runId) throw new Error(`job: replay.runId '${replay.runId}' must match the job runId '${runId}'`);
  // "a job you cannot reproduce is not a job": reject a hollow {schema,kind,runId} that carries nothing to re-run.
  // An operation needs its operationId; a query needs its sql. (The manifest to run against is enforced at reproduce
  // time by reproduceRun, which fails closed without one.)
  if (!replay.operationId && (typeof replay.sql !== "string" || !replay.sql.trim())) throw new Error("job: replay must carry an operationId or non-empty sql — nothing to re-run otherwise (a job you cannot reproduce is not a job)");
}

/** The job lifecycle IS the run lifecycle (queued|running|waiting|succeeded|failed|cancelled). */
export type JobPhase = BioRunStatus;

export interface JobStatus {
  runId: string;
  phase: JobPhase;
  /** the timestamp this phase was observed at — strictly increasing across a job's transitions. */
  at: string;
  progress?: { current?: number; total?: number; unit?: string };
  message?: string;
}

export interface JobArtifactRef {
  name: string;
  /** a CAS address ("sha256:...") — outputs go to CAS, never inline into the job record. */
  digest: string;
  kind?: string;
}

export interface JobResult {
  runId: string;
  phase: JobPhase;
  /** generic result payload (rows, a summary) — the job decides its shape, the substrate stays agnostic. */
  result?: JsonValue;
  artifacts?: JobArtifactRef[];
  error?: string;
}

export type JobHandle = string;

/**
 * The run executor specialization. `submit` starts a job and returns its handle once accepted; `status` and
 * `collect` use that same handle id. A terminal phase (succeeded/failed/cancelled) is stable.
 */
export interface JobRunner extends AsyncRunner<JobSubmitSpec, string, JobStatus, JobResult> {
  submit(spec: JobSubmitSpec): Promise<JobHandle>;
  status(runId: string): Promise<JobStatus | null>;
  collect(runId: string): Promise<JobResult | null>;
  /** OPTIONAL best-effort cancellation (L3). A runner that can stop in-flight work implements it (the in-memory
   *  fake flips a not-yet-terminal job to cancelled; a real runner sends a process-group kill). The DURABLE cancel
   *  — recording the `cancelled` phase in the ledger — is the job-store's job and does not require this. */
  cancel?(runId: string): Promise<void>;
}
