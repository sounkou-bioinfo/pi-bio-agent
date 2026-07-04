import type { JobPhase, JobSubmitSpec } from "../core/jobs.js";
import { assertJobReplay } from "../core/jobs.js";
import type { SqlConn } from "../core/ports.js";
import type { RunReplaySpec } from "../core/reproducibility.js";
import { replaySpecDigest } from "../core/reproducibility.js";

// Durable worker coordination for long-running jobs. The observation ledger remains the audit/status/result truth;
// this table is the operational queue/lease index a worker pool can claim from. Claims are single-statement
// UPDATE ... RETURNING operations so a shared DuckDB lane (local file lock or ducknng RPC server) serializes them.

const TABLE = "pi_bio_job_queue";
const PHASES = new Set<JobPhase>(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
const TERMINAL_PHASES = new Set<JobPhase>(["succeeded", "failed", "cancelled"]);
const WORKER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export type JobTerminalPhase = "succeeded" | "failed" | "cancelled";

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
  if (!rows[0]) throw new Error(`job-queue: job '${req.runId}' is not held by worker '${req.workerId}' with a live lease`);
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
  if (!rows[0]) throw new Error(`job-queue: job '${req.runId}' is not held by worker '${req.workerId}' with a live lease`);
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
  if (!rows[0]) throw new Error(`job-queue: job '${req.runId}' is not held by worker '${req.workerId}' with a live lease`);
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

export async function readJobQueueRecord(conn: SqlConn, runId: string): Promise<JobQueueRecord | null> {
  const rows = await conn.all<JobQueueRow>(
    `SELECT run_id, replay_json, replay_digest, phase, attempt, available_at, claimed_by, claim_expires_at, created_at, updated_at
     FROM ${TABLE} WHERE run_id = ?`,
    [runId],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
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
  if (typeof workerId !== "string" || !WORKER_ID_RE.test(workerId)) {
    throw new Error(`job-queue: workerId '${workerId}' must be a non-empty worker token`);
  }
}

function assertLeaseSeconds(leaseSeconds: number): void {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0 || leaseSeconds > 86400) {
    throw new Error("job-queue: leaseSeconds must be a positive integer no larger than 86400");
  }
}
