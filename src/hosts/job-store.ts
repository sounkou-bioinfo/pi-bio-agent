import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
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
const PHASES = new Set<JobPhase>(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
// compare timestamps as EPOCH ms, never as strings: string '>' mis-orders mixed ISO forms ('…01Z' > '…01.999Z'
// lexicographically but is temporally BEFORE it), which would admit a backdated transition. new Date parses both.
const afterTs = (a: string, b: string): boolean => new Date(a).getTime() > new Date(b).getTime();
const beforeTs = (a: string, b: string): boolean => new Date(a).getTime() < new Date(b).getTime();
const isTerminal = (p: JobPhase): boolean => p === "succeeded" || p === "failed" || p === "cancelled";
// runId is interpolated into a filesystem path (`<runId>.json`) — it MUST be a safe token (no path separators, no
// leading dot), or a hostile/typo'd id could traverse outside `.pi/bio-agent/jobs`. Same shape as a run id.
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const assertSafeRunId = (runId: string): void => {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error(`job-store: unsafe runId '${runId}' (letters/numbers/'.'/'_'/':'/'-', no separators, max 128)`);
};
const slotOf = (runId: string): string => `job:${runId}:status`;
const resultSlotOf = (runId: string): string => `job:${runId}:result`;
const subjectOf = (runId: string): string => `job:${runId}`;
const jobsDir = (cwd: string): string => join(cwd, ".pi", "bio-agent", "jobs");
const jobFile = (cwd: string, runId: string): string => { assertSafeRunId(runId); return join(jobsDir(cwd), `${runId}.json`); };

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
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; // unique per write — concurrent same-process writes for one job never share a temp
  await fs.writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  await fs.rename(tmp, path); // atomic replace — a concurrent reader never sees a partial file
}

/** A JobRunner is host-injected but may be buggy or hostile — VALIDATE what it returns before persisting it into the
 *  ledger/snapshot, or a bad `runId`/`phase` would corrupt the durable record and only fail closed for LATER readers. */
function assertRunnerStatus(runId: string, st: { runId: string; phase: JobPhase }): void {
  if (st.runId !== runId) throw new Error(`job-store: runner returned status for '${st.runId}', expected '${runId}' — refusing to record a mismatched job`);
  if (!PHASES.has(st.phase)) throw new Error(`job-store: runner returned an invalid phase ${JSON.stringify(st.phase)} for '${runId}'`);
}

/** Remove the durable snapshot — compensation for a submit whose runner rejected after the write-ahead marker. */
async function removeJobRecord(cwd: string, runId: string): Promise<void> {
  try { await fs.rm(jobFile(cwd, runId), { force: true }); } catch { /* best-effort: the marker may already be gone */ }
}

/** Read the durable snapshot. Returns null ONLY when the file is absent (ENOENT); a malformed/partial record
 *  THROWS rather than silently becoming a missing job that would erase its replay metadata. */
export async function readJobRecord(cwd: string, runId: string): Promise<JobRecord | null> {
  let text: string;
  try { text = await fs.readFile(jobFile(cwd, runId), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const rec = JSON.parse(text) as JobRecord;
  if (rec.schema !== "pi-bio.job_record.v1" || rec.runId !== runId || typeof rec.replayDigest !== "string"
      || !PHASES.has(rec.phase) || typeof rec.submittedAt !== "string" || typeof rec.updatedAt !== "string") {
    throw new Error(`job-store: malformed job record for '${runId}'`); // fail closed on a corrupt phase/timestamp, not just schema/id
  }
  return rec;
}

async function latestSlotRow(conn: SqlConn, runId: string): Promise<{ phase: JobPhase; at: string; message?: string; progress?: JobStatus["progress"] } | null> {
  const row = await observationAsOfKey(conn, slotOf(runId), FUTURE);
  if (row?.value_json == null) return null;
  // tolerate BOTH a bare phase string (legacy rows) and a rich {phase, message, progress} object — the same
  // shape ledgerJobRunner reads, so a status written by either path round-trips without losing progress/message.
  const v = JSON.parse(row.value_json) as unknown;
  const rec = (typeof v === "object" && v !== null ? v : { phase: v }) as { phase?: unknown; message?: string; progress?: JobStatus["progress"] };
  if (typeof rec.phase !== "string" || !PHASES.has(rec.phase as JobPhase)) {
    throw new Error(`job-store: job '${runId}' has an invalid status phase ${JSON.stringify(rec.phase)} (corrupt/hostile ledger row)`); // fail closed, don't return a bogus typed phase
  }
  return { phase: rec.phase as JobPhase, at: row.recorded_at, message: rec.message, progress: rec.progress };
}

async function recordPhase(conn: SqlConn, runId: string, status: { phase: JobPhase; message?: string; progress?: JobStatus["progress"] }, now: string, source: string, digest: string): Promise<void> {
  // persist the RICH status when there is more than a phase, else a bare phase string — the durable ledger must
  // not drop progress/message (JobStatus carries them and ledgerJobRunner already reads the rich object).
  const value = status.message !== undefined || status.progress !== undefined
    ? { phase: status.phase, message: status.message, progress: status.progress }
    : status.phase;
  await recordObservation(conn, {
    statementKey: slotOf(runId), subjectId: subjectOf(runId), predicate: "job_status",
    value, recordedAt: now, source, digest,
  });
}

export interface SubmitBioJobRequest {
  cwd: string;
  runId: string;
  replay: RunReplaySpec;
  now: string;
  source?: string;
}

/** Submit a job. Fail closed: a well-formed matching replay spec is required, and neither a durable record nor a
 *  ledger row may already exist for the runId. Durability is WRITE-AHEAD: the `queued` snapshot is persisted BEFORE
 *  dispatch, and a runner REJECTION is compensated by removing it (so a rejected submit leaves nothing behind). The
 *  deliberate tradeoff vs dispatch-first: a crash in the tiny window AFTER persist but BEFORE the runner accepts
 *  leaves a durable `queued` record the runner never took (recoverable — a known stuck job — rather than orphaned
 *  work with no record); see the write-ahead note below for how such a record is reconciled. */
export async function submitBioJob(conn: SqlConn, runner: JobRunner, req: SubmitBioJobRequest): Promise<JobStatus> {
  assertJobReplay(req.runId, req.replay);
  if (await readJobRecord(req.cwd, req.runId)) throw new Error(`job-store: job '${req.runId}' already submitted`);
  // Also refuse a runId that already has a LEDGER row (a prior job in the shared store, even if the local snapshot
  // is gone) — otherwise we'd dispatch new work and then adopt the STALE ledger phase/result as this job's state.
  if (await latestSlotRow(conn, req.runId)) throw new Error(`job-store: job '${req.runId}' already exists in the shared ledger (reused runId) — pick a fresh runId`);
  const digest = replaySpecDigest(req.replay); // compute BEFORE any write — a digest failure must leave nothing behind
  // WRITE-AHEAD: persist the durable "submitted" snapshot BEFORE dispatch. So if the process dies right after the
  // runner starts work, the job is still KNOWN (readJobRecord succeeds) and a later poll reconciles the ledger from
  // the runner's status — rather than orphaned work with no durable record. If the runner then REJECTS, compensate
  // by removing the marker. CAVEAT: a crash in the window BEFORE runner.submit is reached leaves a `queued` record
  // the runner never accepted — poll/resume then can't advance it (the runner has no such job). Recovery is to
  // removeJobRecord that runId and re-submit (the ledger row is only written after acceptance, so it stays clean).
  await persistJob(req.cwd, { schema: "pi-bio.job_record.v1", runId: req.runId, phase: "queued", replayDigest: digest, submittedAt: req.now, updatedAt: req.now });
  try {
    await runner.submit({ runId: req.runId, replay: req.replay }); // acceptance — throws if the runner rejects
  } catch (e) {
    await removeJobRecord(req.cwd, req.runId); // compensate: a rejected submit leaves no phantom marker
    throw e;
  }
  // Record the queued ledger row. A dispatched worker (ledgerJobRunner) may ALREADY have reported running/succeeded
  // into the slot — record `queued` ONLY if the slot is still empty, so it can't REGRESS the worker's phase. If THIS
  // write fails, the snapshot above already makes the job known and a later poll records the phase (recoverable).
  const already = await latestSlotRow(conn, req.runId);
  if (!already) await recordPhase(conn, req.runId, { phase: "queued" }, req.now, req.source ?? "job-store", digest);
  return { runId: req.runId, phase: already?.phase ?? "queued", at: already?.at ?? req.now };
}

/** Poll a job: read the runner's current status and record it as a new observation IFF the phase OR the rich status
 *  (progress/message) actually changed AND `now` is strictly after the slot's last row (so the ledger advances only
 *  on real, monotonic updates — durable progress, not every poll). Fails closed if the durable record is missing. */
export async function pollBioJob(conn: SqlConn, runner: JobRunner, req: { cwd: string; runId: string; now: string; source?: string }): Promise<JobStatus> {
  const existing = await readJobRecord(req.cwd, req.runId);
  if (!existing) throw new Error(`job-store: no durable record for job '${req.runId}' (submit it first)`);
  const latest = await latestSlotRow(conn, req.runId);
  // a durably-TERMINAL job is FINAL: never append a later runner phase over it (e.g. a job cancelled in the ledger
  // while the runner still reports succeeded must stay cancelled — the durable ledger wins, not process memory).
  if (latest && isTerminal(latest.phase)) {
    await persistJob(req.cwd, { ...existing, phase: latest.phase, updatedAt: req.now });
    return { runId: req.runId, phase: latest.phase, at: latest.at, message: latest.message, progress: latest.progress };
  }
  const st = await runner.status(req.runId);
  if (!st) throw new Error(`job-store: no job '${req.runId}' is known to the runner`);
  assertRunnerStatus(req.runId, st); // validate the runner's return before it can reach the durable ledger
  // record a new row on a PHASE change OR a same-phase rich-status change (progress/message moved) — so a
  // long-running job's progress is durable and readable as-of t, not just its phase transitions. Recording only
  // on actual CHANGE (not every poll) keeps the ledger bounded to real updates.
  const richChanged = !!latest && latest.phase === st.phase
    && (latest.message !== st.message || JSON.stringify(latest.progress ?? null) !== JSON.stringify(st.progress ?? null));
  if (!latest || latest.phase !== st.phase || richChanged) {
    if (latest && !afterTs(req.now, latest.at)) throw new Error(`job-store: now '${req.now}' must be strictly after the last status at '${latest.at}' to record a transition`);
    await recordPhase(conn, req.runId, { phase: st.phase, message: st.message, progress: st.progress }, req.now, req.source ?? "job-store", existing.replayDigest);
    await persistJob(req.cwd, { ...existing, phase: st.phase, updatedAt: req.now });
    // return the LEDGER-consistent status: the timestamp actually written (req.now), never the runner's clock.
    return { runId: req.runId, phase: st.phase, at: req.now, message: st.message, progress: st.progress };
  }
  await persistJob(req.cwd, { ...existing, phase: st.phase, updatedAt: req.now });
  // no transition: the authoritative timestamp is the durable ledger row's, not the runner's.
  return { runId: req.runId, phase: st.phase, at: latest.at, message: st.message, progress: st.progress };
}

/** L2 — durable RESUME. Rehydrate a job's status from the persisted record + the observation ledger WITHOUT the
 *  in-memory runner (which is gone after a process restart). The ledger slot is the source of truth; the record
 *  is a snapshot. Fails closed if there is no durable record. This is what makes a long-running job survive a
 *  restart: the durable substrate, not process memory, holds the truth. */
export async function resumeBioJob(conn: SqlConn, req: { cwd: string; runId: string }): Promise<JobStatus & { replayDigest: string; submittedAt: string }> {
  const rec = await readJobRecord(req.cwd, req.runId);
  if (!rec) throw new Error(`job-store: no durable record for job '${req.runId}' to resume`);
  const latest = await latestSlotRow(conn, req.runId);
  return {
    runId: req.runId,
    phase: latest?.phase ?? rec.phase, // the ledger wins; the record is a fallback snapshot
    at: latest?.at ?? rec.updatedAt,
    message: latest?.message, // surface the durable rich status — don't degrade a resumed job to bare phase
    progress: latest?.progress,
    replayDigest: rec.replayDigest,
    submittedAt: rec.submittedAt,
  };
}

/** L3 — CANCEL. Record the terminal `cancelled` phase in the ledger (the DURABLE cancel), refresh the snapshot,
 *  and — if the runner supports it — best-effort stop the in-flight work. Fails closed on a missing record, on a
 *  job that is already terminal, and on a non-monotonic `now` (same strictly-after guard as poll). */
export async function cancelBioJob(conn: SqlConn, req: { cwd: string; runId: string; now: string; runner?: JobRunner; source?: string }): Promise<JobStatus> {
  const rec = await readJobRecord(req.cwd, req.runId);
  if (!rec) throw new Error(`job-store: no durable record for job '${req.runId}' to cancel`);
  const latest = await latestSlotRow(conn, req.runId);
  const phase = latest?.phase ?? rec.phase;
  if (isTerminal(phase)) throw new Error(`job-store: job '${req.runId}' is already terminal (${phase}) — cannot cancel`);
  const lastAt = latest?.at ?? rec.updatedAt; // guard against a non-monotonic `now` even when no ledger row exists yet
  if (!afterTs(req.now, lastAt)) throw new Error(`job-store: now '${req.now}' must be strictly after the last status at '${lastAt}' to cancel`);
  // record the DURABLE cancel FIRST, then best-effort stop the work — a runner.cancel that throws must NOT lose the
  // durable cancel (the ledger is the truth; the runner kill is a courtesy).
  await recordPhase(conn, req.runId, { phase: "cancelled" }, req.now, req.source ?? "job-store", rec.replayDigest);
  await persistJob(req.cwd, { ...rec, phase: "cancelled", updatedAt: req.now });
  if (req.runner?.cancel) { try { await req.runner.cancel(req.runId); } catch { /* best-effort: durable cancel already recorded */ } }
  return { runId: req.runId, phase: "cancelled", at: req.now };
}

/** Collect a job's result — null until it is terminal (succeeded/failed/cancelled). */
export async function collectBioJob(runner: JobRunner, runId: string): Promise<JobResult | null> {
  const res = await runner.collect(runId);
  if (!res) return null;
  assertRunnerStatus(runId, res); // validate the runner's return (runId match + valid phase) before any caller records it
  if (res.phase === "queued" || res.phase === "running" || res.phase === "waiting") return null;
  return res;
}

/** Collect a terminal job's result AND durably record it into the ledger (`job:<runId>:result`) as a
 *  `{result?, artifacts?, error?}` envelope — the SAME slot a distributed worker writes and `ledgerJobRunner`
 *  reads. This closes the durability asymmetry: a job run on an in-process runner (whose result lived only in
 *  process memory) now survives the process, so a later `ledgerJobRunner(conn)` or a durable resume can retrieve
 *  it. Null until terminal. Fails closed on a missing durable record (submit it first). Prefer CAS refs for large
 *  artifacts (`JobArtifactRef` carries a digest) so the ledger holds a handle, not inline bytes. */
export async function collectAndRecordBioJob(conn: SqlConn, runner: JobRunner, req: { cwd: string; runId: string; now: string; source?: string }): Promise<JobResult | null> {
  const rec = await readJobRecord(req.cwd, req.runId);
  if (!rec) throw new Error(`job-store: no durable record for job '${req.runId}' (submit it first)`);
  const res = await collectBioJob(runner, req.runId);
  if (!res) return null; // not terminal yet — nothing durable to record
  const latest = await latestSlotRow(conn, req.runId);
  // DURABLY-TERMINAL WINS: if the ledger is already terminal in a DIFFERENT state than the runner reports (the
  // classic case: a durable CANCEL while a local runner kept going and now says succeeded), the ledger is the
  // truth — never record the runner's conflicting result. Return the durable terminal state instead.
  if (latest && isTerminal(latest.phase) && latest.phase !== res.phase) {
    return { runId: req.runId, phase: latest.phase, ...(latest.phase === "failed" && latest.message ? { error: latest.message } : {}) };
  }
  // ensure the durable STATUS slot is terminal FIRST: ledgerJobRunner.collect gates on terminal status, so a result
  // recorded while status still says queued/running would be unreachable. Record the terminal phase if the ledger
  // hasn't got there yet (e.g. the caller collected without polling to terminal).
  if (!latest || !isTerminal(latest.phase)) {
    if (latest && !afterTs(req.now, latest.at)) throw new Error(`job-store: now '${req.now}' must be strictly after the last status at '${latest.at}' to record the terminal status`);
    await recordPhase(conn, req.runId, { phase: res.phase, message: res.error }, req.now, req.source ?? "job-store", rec.replayDigest);
    await persistJob(req.cwd, { ...rec, phase: res.phase, updatedAt: req.now });
  }
  // TAG the envelope so the reader can never mistake a bare result value (which may itself be an object with a
  // `result`/`error` key) for an envelope — the schema marker is the unambiguous discriminator.
  // the result must not predate its own terminal STATUS in as-of history: if the ledger is already terminal,
  // req.now must be at-or-after that terminal time (else a result would be visible before the status that produced
  // it). `latest` is re-read here because the block above may have just recorded the terminal status.
  const terminal = await latestSlotRow(conn, req.runId);
  if (terminal && isTerminal(terminal.phase) && beforeTs(req.now, terminal.at)) throw new Error(`job-store: result 'now' ${req.now} is before the terminal status at ${terminal.at} — refusing to record a result that predates its status`);
  const envelope: { schema: "pi-bio.job_result.v1"; result?: JobResult["result"]; artifacts?: JobResult["artifacts"]; error?: string } = { schema: "pi-bio.job_result.v1" };
  if (res.result !== undefined) envelope.result = res.result;
  if (res.artifacts !== undefined) envelope.artifacts = res.artifacts;
  if (res.error !== undefined) envelope.error = res.error;
  await recordObservation(conn, {
    statementKey: resultSlotOf(req.runId), subjectId: subjectOf(req.runId), predicate: "job_result",
    value: envelope, recordedAt: req.now, source: req.source ?? "job-store", digest: rec.replayDigest,
  });
  return res;
}
