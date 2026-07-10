import { createHash } from "node:crypto";
import type { JobArtifactRef, JobPhase, JobStatus, JobSubmitSpec } from "../core/jobs.js";
import { assertJobReplay } from "../core/jobs.js";
import type { JsonValue } from "../core/json.js";
import type { SqlConn } from "../core/ports.js";
import type { RunReplaySpec } from "../core/reproducibility.js";
import { replaySpecDigest } from "../core/reproducibility.js";

// Durable worker coordination for long-running jobs. The observation ledger remains the audit/status/result truth;
// this table is the operational queue/lease index a worker pool can claim from. Claims are single-statement
// UPDATE ... RETURNING operations so a shared DuckDB lane (local file lock or ducknng RPC server) serializes them.

const TABLE = "pi_bio_job_queue";
const PHASES = new Set<JobPhase>(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const TERMINAL_PHASES = new Set<JobPhase>(["succeeded", "failed", "cancelled"]);
const MAX_WORKER_ID_BYTES = 128;

export type JobTerminalPhase = "succeeded" | "failed" | "cancelled";

export type JobClaimLostOperation = "heartbeat" | "park" | "finish" | "record-observation";

export class JobClaimLostError extends Error {
  constructor(
    readonly operation: JobClaimLostOperation,
    readonly runId: string,
    readonly workerId: string,
  ) {
    super(`job-queue: job '${runId}' is not held by worker '${workerId}' (operation=${operation})`);
    this.name = "JobClaimLostError";
  }
}

export interface JobQueueRecord {
  runId: string;
  replayDigest: string;
  phase: JobPhase;
  attempt: number;
  availableAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobQueueClaim extends JobQueueRecord {
  replay: RunReplaySpec;
  phase: "running";
  claimedBy: string;
  claimExpiresAt: string;
}

interface JobQueueRow {
  run_id: string;
  replay_json: string;
  replay_digest: string;
  phase: JobPhase;
  attempt: number | bigint;
  available_at: string;
  claimed_by: string | null;
  claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function createJobQueueSchema(conn: SqlConn, opts: { ifNotExists?: boolean } = {}): Promise<void> {
  const ine = opts.ifNotExists === false ? "" : "IF NOT EXISTS ";
  await conn.run(
    `CREATE TABLE ${ine}${TABLE} (` +
      "run_id TEXT PRIMARY KEY, replay_json TEXT NOT NULL, replay_digest TEXT NOT NULL, " +
      "phase TEXT NOT NULL CHECK (phase IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')), " +
      "attempt BIGINT NOT NULL DEFAULT 0, available_at TEXT NOT NULL, claimed_by TEXT, claim_expires_at TEXT, " +
      "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  await conn.run(`CREATE INDEX ${ine}${TABLE}_phase_available ON ${TABLE} (phase, available_at)`);
  await conn.run(`CREATE INDEX ${ine}${TABLE}_claim_expiry ON ${TABLE} (phase, claim_expires_at)`);
}

export interface EnqueueJobRequest extends JobSubmitSpec {
  now: string;
  availableAt?: string;
}

/** Enqueue a replayable job. Duplicate runIds fail closed: callers needing retries should use a stable idempotency
 *  key above this layer rather than silently adopting a stale row. */
export async function enqueueJob(conn: SqlConn, req: EnqueueJobRequest): Promise<JobQueueRecord> {
  assertJobReplay(req.runId, req.replay);
  await assertTimestamp(conn, "now", req.now);
  const availableAt = req.availableAt ?? req.now;
  await assertTimestamp(conn, "availableAt", availableAt);
  const digest = replaySpecDigest(req.replay);
  await conn.run(
    `INSERT INTO ${TABLE} (run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?)`,
    [req.runId, JSON.stringify(req.replay), digest, availableAt, req.now, req.now],
  );
  const row = await readJobQueueRecord(conn, req.runId);
  if (!row) throw new Error(`job-queue: failed to read enqueued job '${req.runId}'`);
  return row;
}

export interface ClaimJobRequest {
  workerId: string;
  now: string;
  leaseSeconds: number;
}

/** Claim the oldest available queued/waiting job, or reclaim an expired running lease. Returns null when no job is
 *  available. The statement is atomic: two workers cannot both receive the same runId from one serialized SQL lane. */
export async function claimJob(conn: SqlConn, req: ClaimJobRequest): Promise<JobQueueClaim | null> {
  assertWorkerId(req.workerId);
  assertLeaseSeconds(req.leaseSeconds);
  await assertTimestamp(conn, "now", req.now);
  const rows = await conn.all<JobQueueRow>(
    `UPDATE ${TABLE}
     SET phase = 'running',
         claimed_by = ?,
         claim_expires_at = CAST(?::TIMESTAMPTZ + (? * INTERVAL '1 second') AS VARCHAR),
         attempt = attempt + 1,
         updated_at = ?
     WHERE run_id = (
       SELECT run_id FROM ${TABLE}
       WHERE ((phase IN ('queued', 'waiting') AND available_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
          OR (phase = 'running' AND claim_expires_at IS NOT NULL AND claim_expires_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ))
       ORDER BY available_at::TIMESTAMPTZ ASC, created_at::TIMESTAMPTZ ASC, run_id ASC
       LIMIT 1
     )
     RETURNING run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at`,
    [req.workerId, req.now, req.leaseSeconds, req.now, req.now, req.now],
  );
  return rows[0] ? rowToClaim(rows[0]) : null;
}

export interface HeartbeatJobClaimRequest {
  runId: string;
  workerId: string;
  now: string;
  leaseSeconds: number;
}

/** Extend a live claim. A stale owner cannot heartbeat after its lease expired; this prevents late writes from an
 *  old attempt from racing a reclaimed attempt. */
export async function heartbeatJobClaim(conn: SqlConn, req: HeartbeatJobClaimRequest): Promise<JobQueueClaim> {
  assertWorkerId(req.workerId);
  assertLeaseSeconds(req.leaseSeconds);
  await assertTimestamp(conn, "now", req.now);
  const rows = await conn.all<JobQueueRow>(
    `UPDATE ${TABLE}
     SET claim_expires_at = CAST(?::TIMESTAMPTZ + (? * INTERVAL '1 second') AS VARCHAR),
         updated_at = ?
     WHERE run_id = ? AND phase = 'running' AND claimed_by = ? AND claim_expires_at::TIMESTAMPTZ > ?::TIMESTAMPTZ
     RETURNING run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at`,
    [req.now, req.leaseSeconds, req.now, req.runId, req.workerId, req.now],
  );
  if (!rows[0]) {
    throw new JobClaimLostError("heartbeat", req.runId, req.workerId);
  }
  return rowToClaim(rows[0]);
}

export interface ParkJobClaimRequest {
  runId: string;
  workerId: string;
  now: string;
  availableAt: string;
}

/** Park a live claim back into `waiting` until `availableAt`. This is the small wait/retry primitive; event-driven
 *  wakeups can later update `available_at`, while push notifications remain only an accelerator. */
export async function parkJobClaim(conn: SqlConn, req: ParkJobClaimRequest): Promise<JobQueueRecord> {
  assertWorkerId(req.workerId);
  await assertTimestamp(conn, "now", req.now);
  await assertTimestamp(conn, "availableAt", req.availableAt);
  const rows = await conn.all<JobQueueRow>(
    `UPDATE ${TABLE}
     SET phase = 'waiting',
         available_at = ?,
         claimed_by = NULL,
         claim_expires_at = NULL,
         updated_at = ?
     WHERE run_id = ? AND phase = 'running' AND claimed_by = ? AND claim_expires_at::TIMESTAMPTZ > ?::TIMESTAMPTZ
     RETURNING run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at`,
    [req.availableAt, req.now, req.runId, req.workerId, req.now],
  );
  if (!rows[0]) {
    throw new JobClaimLostError("park", req.runId, req.workerId);
  }
  return rowToRecord(rows[0]);
}

export interface FinishJobClaimRequest {
  runId: string;
  workerId: string;
  now: string;
  phase: JobTerminalPhase;
}

/** Mark a live claim terminal in the operational queue. The worker should record status/result in the job ledger
 *  before or with this transition; this table is not the audit ledger. */
export async function finishJobClaim(conn: SqlConn, req: FinishJobClaimRequest): Promise<JobQueueRecord> {
  assertWorkerId(req.workerId);
  if (!TERMINAL_PHASES.has(req.phase)) throw new Error(`job-queue: finish phase must be terminal, got '${req.phase}'`);
  await assertTimestamp(conn, "now", req.now);
  const rows = await conn.all<JobQueueRow>(
    `UPDATE ${TABLE}
     SET phase = ?,
         available_at = ?,
         claimed_by = NULL,
         claim_expires_at = NULL,
         updated_at = ?
     WHERE run_id = ? AND phase = 'running' AND claimed_by = ? AND claim_expires_at::TIMESTAMPTZ > ?::TIMESTAMPTZ
     RETURNING run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at`,
    [req.phase, req.now, req.now, req.runId, req.workerId, req.now],
  );
  if (!rows[0]) {
    throw new JobClaimLostError("finish", req.runId, req.workerId);
  }
  return rowToRecord(rows[0]);
}

export interface CancelQueuedJobRequest {
  runId: string;
  now: string;
}

/** Mark a non-terminal queued/running/waiting job cancelled in the operational queue. This does not kill an
 *  already-running worker; it prevents future claims/reclaims. The durable cancellation fact still belongs in the
 *  job ledger (`cancelBioJob` records it there). */
export async function cancelQueuedJob(conn: SqlConn, req: CancelQueuedJobRequest): Promise<JobQueueRecord> {
  await assertTimestamp(conn, "now", req.now);
  const rows = await conn.all<JobQueueRow>(
    `UPDATE ${TABLE}
     SET phase = 'cancelled',
         available_at = ?,
         claimed_by = NULL,
         claim_expires_at = NULL,
         updated_at = ?
     WHERE run_id = ? AND phase NOT IN ('succeeded', 'failed', 'cancelled')
     RETURNING run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at`,
    [req.now, req.now, req.runId],
  );
  if (!rows[0]) {
    const existing = await readJobQueueRecord(conn, req.runId);
    if (!existing) throw new Error(`job-queue: unknown job '${req.runId}'`);
    if (TERMINAL_PHASES.has(existing.phase)) throw new Error(`job-queue: job '${req.runId}' is already terminal (${existing.phase})`);
    throw new Error(`job-queue: failed to cancel job '${req.runId}'`);
  }
  return rowToRecord(rows[0]);
}

export interface LiveJobClaimRequest {
  runId: string;
  workerId: string;
  attempt: number;
  recordedAt: string;
}

export interface RecordJobClaimStatusRequest extends LiveJobClaimRequest {
  phase: JobPhase;
  replayDigest: string;
  source?: string;
  message?: string;
  progress?: JobStatus["progress"];
}

export interface RecordJobClaimResultRequest extends LiveJobClaimRequest {
  replayDigest: string;
  source?: string;
  result?: JsonValue;
  artifacts?: JobArtifactRef[];
  error?: string;
}

/** Record worker status only while the caller still owns the live queue claim. This is the durable-worker guard
 *  a transport backend needs: NNG/mirai cancellation is best-effort, so stale workers must be rejected at the
 *  ledger boundary, not trusted to stop. */
export async function recordJobClaimStatus(conn: SqlConn, req: RecordJobClaimStatusRequest): Promise<JobStatus> {
  if (!PHASES.has(req.phase)) throw new Error(`job-queue: invalid status phase '${String(req.phase)}'`);
  const value = req.message !== undefined || req.progress !== undefined
    ? { phase: req.phase, message: req.message, progress: req.progress }
    : req.phase;
  await insertObservationForLiveClaim(conn, req, {
    statementKey: `job:${req.runId}:status`,
    subjectId: `job:${req.runId}`,
    predicate: "job_status",
    value,
    source: req.source ?? req.workerId,
    digest: req.replayDigest,
    attrs: { worker_id: req.workerId, attempt: req.attempt },
  });
  return { runId: req.runId, phase: req.phase, at: req.recordedAt, message: req.message, progress: req.progress };
}

/** Record a worker result only while the caller still owns the live queue claim. The schema envelope matches
 *  collectAndRecordBioJob / ledgerJobRunner so in-process and distributed workers share one result slot. */
export async function recordJobClaimResult(conn: SqlConn, req: RecordJobClaimResultRequest): Promise<string> {
  const envelope: { schema: "pi-bio.job_result.v1"; result?: JsonValue; artifacts?: JobArtifactRef[]; error?: string } = { schema: "pi-bio.job_result.v1" };
  if (req.result !== undefined) {
    assertJsonValue(req.result, "job-queue: result");
    envelope.result = req.result;
  }
  if (req.artifacts !== undefined) {
    assertJsonValue(req.artifacts, "job-queue: artifacts");
    envelope.artifacts = req.artifacts;
  }
  if (req.error !== undefined) envelope.error = req.error;
  return insertObservationForLiveClaim(conn, req, {
    statementKey: `job:${req.runId}:result`,
    subjectId: `job:${req.runId}`,
    predicate: "job_result",
    value: envelope,
    source: req.source ?? req.workerId,
    digest: req.replayDigest,
    attrs: { worker_id: req.workerId, attempt: req.attempt },
  });
}

export async function readJobQueueRecord(conn: SqlConn, runId: string): Promise<JobQueueRecord | null> {
  const rows = await conn.all<JobQueueRow>(
    `SELECT run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at
     FROM ${TABLE} WHERE run_id = ?`,
    [runId],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

interface ClaimGatedObservation {
  statementKey: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  source: string;
  digest: string;
  attrs?: Record<string, unknown>;
}

async function insertObservationForLiveClaim(conn: SqlConn, req: LiveJobClaimRequest, obs: ClaimGatedObservation): Promise<string> {
  assertWorkerId(req.workerId);
  if (!Number.isInteger(req.attempt) || req.attempt < 1) throw new Error("job-queue: attempt must be a positive integer");
  await assertTimestamp(conn, "recordedAt", req.recordedAt);
  const valueJson = JSON.stringify(obs.value);
  const attrsJson = obs.attrs ? JSON.stringify(obs.attrs) : null;
  const id = observationId({ ...obs, recordedAt: req.recordedAt });
  const rows = await conn.all<{ observation_id: string }>(
    `INSERT INTO bio_observations (observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at, valid_from, valid_to, source, digest, attrs, trust)
     SELECT ?, ?, ?, ?, NULL, ?::JSON, ?, NULL, NULL, ?, ?, ?::JSON, NULL
     WHERE EXISTS (
       SELECT 1 FROM ${TABLE}
       WHERE run_id = ?
         AND phase = 'running'
         AND claimed_by = ?
         AND attempt = ?
         AND claim_expires_at::TIMESTAMPTZ > ?::TIMESTAMPTZ
     )
     ON CONFLICT (observation_id) DO NOTHING
     RETURNING observation_id`,
    [id, obs.statementKey, obs.subjectId, obs.predicate, valueJson, req.recordedAt, obs.source, obs.digest, attrsJson, req.runId, req.workerId, req.attempt, req.recordedAt],
  );
  if (rows[0]) return rows[0].observation_id;
  const existing = await conn.all<{ observation_id: string }>("SELECT observation_id FROM bio_observations WHERE observation_id = ?", [id]);
  if (existing[0]) return id;
  throw new JobClaimLostError("record-observation", req.runId, req.workerId);
}

function observationId(obs: ClaimGatedObservation & { recordedAt: string }): `sha256:${string}` {
  const canonical = JSON.stringify([
    obs.statementKey,
    obs.subjectId,
    obs.predicate,
    null,
    obs.value ?? null,
    obs.recordedAt,
    null,
    null,
    obs.source,
    obs.digest,
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function rowToRecord(row: JobQueueRow): JobQueueRecord {
  if (!PHASES.has(row.phase)) throw new Error(`job-queue: invalid phase '${String(row.phase)}' for job '${row.run_id}'`);
  const replay = parseReplay(row);
  const digest = replaySpecDigest(replay);
  if (digest !== row.replay_digest) throw new Error(`job-queue: replay digest mismatch for job '${row.run_id}'`);
  return {
    runId: row.run_id,
    replayDigest: row.replay_digest,
    phase: row.phase,
    attempt: Number(row.attempt),
    availableAt: row.available_at,
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at ? { claimExpiresAt: row.claim_expires_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToClaim(row: JobQueueRow): JobQueueClaim {
  const rec = rowToRecord(row);
  const replay = parseReplay(row);
  if (rec.phase !== "running" || !rec.claimedBy || !rec.claimExpiresAt) {
    throw new Error(`job-queue: claimed row for job '${row.run_id}' is not a live running claim`);
  }
  return { ...rec, replay, phase: "running", claimedBy: rec.claimedBy, claimExpiresAt: rec.claimExpiresAt };
}

function parseReplay(row: JobQueueRow): RunReplaySpec {
  const replay = JSON.parse(row.replay_json) as RunReplaySpec;
  assertJobReplay(row.run_id, replay);
  return replay;
}

async function assertTimestamp(conn: SqlConn, label: string, value: string): Promise<void> {
  if (typeof value !== "string" || value.length === 0) throw new Error(`job-queue: ${label} must be a non-empty timestamp`);
  try {
    await conn.all(`SELECT ?::TIMESTAMPTZ`, [value]);
  } catch {
    throw new Error(`job-queue: ${label} '${value}' must be a DuckDB-castable TIMESTAMPTZ`);
  }
}

function assertWorkerId(workerId: string): void {
  if (typeof workerId !== "string" || workerId.length === 0 || workerId.trim() !== workerId || Buffer.byteLength(workerId, "utf8") > MAX_WORKER_ID_BYTES) {
    throw new Error(`job-queue: workerId '${workerId}' must be a non-empty trimmed string no longer than ${MAX_WORKER_ID_BYTES} UTF-8 bytes`);
  }
}

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 86400) {
    throw new Error("job-queue: leaseSeconds must be a positive integer no larger than 86400");
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`${label}: ${path} must be a finite JSON number`);
      return;
    }
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) visit(item, `${path}[${i}]`);
      return;
    }
    if (typeof v === "object" && v !== null) {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${label}: ${path} must be a plain JSON object`);
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        if (item === undefined) throw new Error(`${label}: ${path}.${k} must not be undefined`);
        visit(item, `${path}.${k}`);
      }
      return;
    }
    throw new Error(`${label}: ${path} must be JSON-serializable`);
  };
  visit(value, "$");
}
