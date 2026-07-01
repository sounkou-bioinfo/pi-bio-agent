import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SqlConn } from "../core/ports.js";
import { assertJobReplay, type JobRunner, type JobResult, type JobStatus, type JobPhase } from "../core/jobs.js";
import type { RunReplaySpec } from "../core/reproducibility.js";
import { replaySpecDigest } from "../core/reproducibility.js";
import { recordObservation, observationAsOfKey } from "../duckdb/observations.js";

// The durable, temporal LEDGER over a JobRunner (L1). The runner executes; the job-store records every status
// transition into the SAME substrate as Phase 4 — a `job:<runId>:status` observation slot — so "what was this
// job's status as of t" is an as-of query, and it persists a `.pi/bio-agent/jobs/<runId>.json` snapshot that
// survives the process. A job MUST carry a well-formed RunReplaySpec whose runId matches (fail closed): a run you
// cannot reproduce is not a job.
//
// Correctness invariants (all fail-closed): submit records NOTHING until the runner ACCEPTS (no phantom jobs);
// a transition is recorded only with a strictly-greater `now` than the slot's last row (equal/backdated is
// rejected, so "current status" is never ambiguous); every recorded transition carries the job's replay digest
// (reproducible provenance); the snapshot is written atomically (temp+rename) and read back ENOENT-tolerant only.

const FUTURE = "9999-12-31T23:59:59.999Z"; // sentinel for "the absolute latest row of a slot, regardless of now"
const slotOf = (runId: string): string => `job:${runId}:status`;
const subjectOf = (runId: string): string => `job:${runId}`;
const jobsDir = (cwd: string): string => join(cwd, ".pi", "bio-agent", "jobs");
const jobFile = (cwd: string, runId: string): string => join(jobsDir(cwd), `${runId}.json`);

export interface JobRecord {
  schema: "pi-bio.job_record.v1";
  runId: string;
  phase: JobPhase;
  replayDigest: string;
  submittedAt: string;
  updatedAt: string;
}

async function persistJob(cwd: string, rec: JobRecord): Promise<void> {
  await fs.mkdir(jobsDir(cwd), { recursive: true });
  const path = jobFile(cwd, rec.runId);
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  await fs.rename(tmp, path); // atomic replace — a concurrent reader never sees a partial file
}

/** Read the durable snapshot. Returns null ONLY when the file is absent (ENOENT); a malformed/partial record
 *  THROWS rather than silently becoming a missing job that would erase its replay metadata. */
export async function readJobRecord(cwd: string, runId: string): Promise<JobRecord | null> {
  let text: string;
  try { text = await fs.readFile(jobFile(cwd, runId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const rec = JSON.parse(text) as JobRecord;
  if (rec.schema !== "pi-bio.job_record.v1" || rec.runId !== runId || typeof rec.replayDigest !== "string") {
    throw new Error(`job-store: malformed job record for '${runId}'`);
  }
  return rec;
}

async function latestSlotRow(conn: SqlConn, runId: string): Promise<{ phase: JobPhase; at: string } | null> {
  const row = await observationAsOfKey(conn, slotOf(runId), FUTURE);
  return row?.value_json != null ? { phase: JSON.parse(row.value_json) as JobPhase, at: row.recorded_at } : null;
}

async function recordPhase(conn: SqlConn, runId: string, phase: JobPhase, now: string, source: string, digest: string): Promise<void> {
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

/** Submit a job. Fail closed: a well-formed matching replay spec is required, a durable record must not already
 *  exist, and the runner must ACCEPT before the ledger/snapshot are touched (so a rejected submit leaves nothing
 *  behind). Records `queued` and persists the snapshot only after acceptance. */
export async function submitBioJob(conn: SqlConn, runner: JobRunner, req: SubmitBioJobRequest): Promise<JobStatus> {
  assertJobReplay(req.runId, req.replay);
  if (await readJobRecord(req.cwd, req.runId)) throw new Error(`job-store: job '${req.runId}' already submitted`);
  await runner.submit({ runId: req.runId, replay: req.replay }); // acceptance first — throws if the runner rejects
  const digest = replaySpecDigest(req.replay);
  await recordPhase(conn, req.runId, "queued", req.now, req.source ?? "job-store", digest);
  await persistJob(req.cwd, { schema: "pi-bio.job_record.v1", runId: req.runId, phase: "queued", replayDigest: digest, submittedAt: req.now, updatedAt: req.now });
  return { runId: req.runId, phase: "queued", at: req.now };
}

/** Poll a job: read the runner's current status and record it as a new observation IFF the phase actually changed
 *  AND `now` is strictly after the slot's last row (so the ledger advances only on real, monotonic transitions).
 *  Fails closed if the durable record is missing. Every recorded transition carries the job's replay digest. */
export async function pollBioJob(conn: SqlConn, runner: JobRunner, req: { cwd: string; runId: string; now: string; source?: string }): Promise<JobStatus> {
  const existing = await readJobRecord(req.cwd, req.runId);
  if (!existing) throw new Error(`job-store: no durable record for job '${req.runId}' (submit it first)`);
  const st = await runner.status(req.runId);
  if (!st) throw new Error(`job-store: no job '${req.runId}' is known to the runner`);
  const latest = await latestSlotRow(conn, req.runId);
  if (!latest || latest.phase !== st.phase) {
    if (latest && !(req.now > latest.at)) throw new Error(`job-store: now '${req.now}' must be strictly after the last status at '${latest.at}' to record a transition`);
    await recordPhase(conn, req.runId, st.phase, req.now, req.source ?? "job-store", existing.replayDigest);
  }
  await persistJob(req.cwd, { ...existing, phase: st.phase, updatedAt: req.now });
  return st;
}

/** Collect a job's result — null until it is terminal (succeeded/failed/cancelled). */
export async function collectBioJob(runner: JobRunner, runId: string): Promise<JobResult | null> {
  const res = await runner.collect(runId);
  if (!res || res.phase === "queued" || res.phase === "running" || res.phase === "waiting") return null;
  return res;
}
