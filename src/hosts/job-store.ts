import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SqlConn } from "../core/ports.js";
import type { JobRunner, JobResult, JobStatus, JobPhase } from "../core/jobs.js";
import type { RunReplaySpec } from "../core/reproducibility.js";
import { replaySpecDigest } from "../core/reproducibility.js";
import { recordObservation, observationAsOfKey } from "../duckdb/observations.js";

// The durable, temporal LEDGER over a JobRunner (L1). The runner executes; the job-store records every status
// transition into the SAME substrate as Phase 4 — a `job:<runId>:status` observation slot — so "what was this
// job's status as of t" is an as-of query, and it persists a `.pi/bio-agent/jobs/<runId>.json` snapshot that
// survives the process. A job MUST carry a RunReplaySpec (fail closed): a run you cannot reproduce is not a job.
//
// Strictly-increasing `now` per call is the caller's contract (same as the run-store / Phase-4 recorders): two
// state changes for one slot at the same timestamp are ambiguous, so the host advances the clock per transition.

const TERMINAL: ReadonlySet<JobPhase> = new Set<JobPhase>(["succeeded", "failed", "cancelled"]);
const slotOf = (runId: string): string => `job:${runId}:status`;
const subjectOf = (runId: string): string => `job:${runId}`;
const jobFile = (cwd: string, runId: string): string => join(cwd, ".pi", "bio-agent", "jobs", `${runId}.json`);

export interface JobRecord {
  schema: "pi-bio.job_record.v1";
  runId: string;
  phase: JobPhase;
  replayDigest: string;
  submittedAt: string;
  updatedAt: string;
}

async function persistJob(cwd: string, rec: JobRecord): Promise<void> {
  const path = jobFile(cwd, rec.runId);
  await fs.mkdir(join(cwd, ".pi", "bio-agent", "jobs"), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

async function lastPhase(conn: SqlConn, runId: string, now: string): Promise<JobPhase | null> {
  const row = await observationAsOfKey(conn, slotOf(runId), now);
  return row?.value_json != null ? (JSON.parse(row.value_json) as JobPhase) : null;
}

async function recordPhase(conn: SqlConn, runId: string, phase: JobPhase, now: string, source: string, digest?: string): Promise<void> {
  await recordObservation(conn, {
    statementKey: slotOf(runId), subjectId: subjectOf(runId), predicate: "job_status",
    value: phase, recordedAt: now, source, digest,
  });
}

export interface SubmitBioJobRequest {
  cwd: string;
  runId: string;
  replay: RunReplaySpec;
  now: string;
  source?: string;
}

/** Submit a job: fail closed without a replay spec, record the `queued` status observation, persist, and hand the
 *  work to the runner. Returns the queued status. */
export async function submitBioJob(conn: SqlConn, runner: JobRunner, req: SubmitBioJobRequest): Promise<JobStatus> {
  if (!req.replay || typeof req.replay !== "object") throw new Error("job-store: a job must carry a RunReplaySpec (fail closed)");
  const digest = replaySpecDigest(req.replay);
  await recordPhase(conn, req.runId, "queued", req.now, req.source ?? "job-store", digest);
  await persistJob(req.cwd, { schema: "pi-bio.job_record.v1", runId: req.runId, phase: "queued", replayDigest: digest, submittedAt: req.now, updatedAt: req.now });
  await runner.submit({ runId: req.runId, replay: req.replay });
  return { runId: req.runId, phase: "queued", at: req.now };
}

/** Poll a job: read the runner's current status, record it as a new observation IF the phase changed (so the slot
 *  ledger only advances on real transitions), refresh the persisted snapshot, and return the status. */
export async function pollBioJob(conn: SqlConn, runner: JobRunner, req: { cwd: string; runId: string; now: string; source?: string }): Promise<JobStatus> {
  const st = await runner.status(req.runId);
  if (!st) throw new Error(`job-store: no job '${req.runId}' is known to the runner`);
  const prior = await lastPhase(conn, req.runId, req.now);
  if (prior !== st.phase) await recordPhase(conn, req.runId, st.phase, req.now, req.source ?? "job-store");
  const existing = await readJobRecord(req.cwd, req.runId);
  await persistJob(req.cwd, {
    schema: "pi-bio.job_record.v1", runId: req.runId, phase: st.phase,
    replayDigest: existing?.replayDigest ?? "", submittedAt: existing?.submittedAt ?? req.now, updatedAt: req.now,
  });
  return st;
}

/** Collect a job's result (null until it exists). Only meaningful once the phase is terminal. */
export async function collectBioJob(runner: JobRunner, runId: string): Promise<JobResult | null> {
  const res = await runner.collect(runId);
  if (res && !TERMINAL.has(res.phase)) return null; // not done yet
  return res;
}

export async function readJobRecord(cwd: string, runId: string): Promise<JobRecord | null> {
  try { return JSON.parse(await fs.readFile(jobFile(cwd, runId), "utf8")) as JobRecord; } catch { return null; }
}
