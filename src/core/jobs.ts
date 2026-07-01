import type { RunReplaySpec } from "./reproducibility.js";
import type { BioRunStatus } from "./run-spec.js";
import type { JsonValue } from "./json.js";

// L1 — the async/long-running lane. Bio work is minutes-to-hours (a whole-VCF annotation, an alignment, a
// cohort regression), so a run must be able to OUTLIVE the call that started it. A job is a run made DURABLE and
// ASYNC: it carries the RunReplaySpec (the actual replay inputs C2's reproduce() re-executes), so a worker can
// run it out-of-band AND it stays reproducible. Job status is the SAME temporal substrate as Phase 4: a
// `job:<runId>:status` observation slot, so "what was this job's status as of t" is an as-of query, not bespoke.
//
// This is the PORT (the seam a host implements); the interface is the contract. The in-memory fake is the second
// impl from day one (the doctrine: accept interfaces, and a port earns itself only with a real second impl — the
// fake is the mocking case). A real host backs it with a queue / worker pool / ducknng topology later — no NNG,
// no cancel, no real out-of-process exec in L1.

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
  if (replay.kind !== "query" && replay.kind !== "operation" && replay.kind !== "process.compute") throw new Error(`job: replay.kind '${String(replay.kind)}' is invalid`);
  if (replay.runId !== runId) throw new Error(`job: replay.runId '${replay.runId}' must match the job runId '${runId}'`);
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

/**
 * The executor port. `submit` starts a job (returns once it is accepted, NOT once it finishes); `status` and
 * `collect` poll. A terminal phase (succeeded/failed/cancelled) is stable — once reported it does not change.
 */
export interface JobRunner {
  submit(spec: JobSubmitSpec): Promise<void>;
  status(runId: string): Promise<JobStatus | null>;
  collect(runId: string): Promise<JobResult | null>;
  /** OPTIONAL best-effort cancellation (L3). A runner that can stop in-flight work implements it (the in-memory
   *  fake flips a not-yet-terminal job to cancelled; a real runner sends a process-group kill). The DURABLE cancel
   *  — recording the `cancelled` phase in the ledger — is the job-store's job and does not require this. */
  cancel?(runId: string): Promise<void>;
}
