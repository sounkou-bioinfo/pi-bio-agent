import { randomUUID } from "node:crypto";
import type { CasStore } from "../core/cas.js";
import type { SqlConn } from "../core/ports.js";
import type { ContentAddress } from "../core/resources.js";

// METADATA-DRIVEN CAS GARBAGE COLLECTION — the distributed-correct GC, as SQL.
//
// The node-local sweeper (gc.ts) scrapes digests out of local run receipts and mark-and-sweeps the filesystem.
// That is correct only when THIS process is the sole writer. The moment a CAS is SHARED — cross-db reuse, an
// NNG/ducknng-topology worker pool, a shared mount — local receipts are an INCOMPLETE root set and a naive sweep
// deletes another live writer's bytes. The library advertises that shared/distributed surface, so it must ship
// the safe GC, not a warning label.
//
// The fix is our own substrate shape ([[semantic-sql-graph-substrate]]): roots become ROWS, GC becomes a SQL
// ANTI-JOIN, owned by a METADATA AUTHORITY. The authority is just a DuckDB holding three tables; whether that
// DuckDB is a local file or a ducknng-served shared db is a HOST COMPOSITION choice, not a code change — the SAME
// SQL below runs over either SqlConn, and the ducknng RPC server that already serializes the shared blackboard
// table serializes these too ([[duckdb-process-boundary-locking]]). Transport is orthogonal; correctness is SQL.
//
//   cas_object  the heap: every stored blob + its lifecycle state (committed -> tombstoned -> deleting -> deleted)
//   cas_ref     durable references (a run, an artifact, a remote-index entry, a manual pin) — the ROOT SET as rows
//   cas_lease   in-flight reads/writes — protects bytes a writer is about to REUSE but has not yet rooted
//
// GC = mark (tombstone every committed object older than a cutoff with NO live ref AND NO live lease) -> wait a
// grace -> sweep (delete the bytes of tombstoned objects past the grace, then mark them deleted). State
// transitions + a serialized authority give correctness; we never "hope a local view is complete."
//
// THE REUSE RACE, closed by leases: a writer that wants to reuse an existing blob across the shared store must
// `withCasObject` — acquire a lease FIRST, then re-check the object is still committed. If the lease lands before
// the mark transaction commits, mark sees it and retains the object. If mark already tombstoned it, the re-check
// catches that and (since the bytes are not yet swept, only tombstoned) RESURRECTS it under the held lease. Only
// a fully `deleted` object is a true miss. `minAgeMs`/grace is then a fallback margin, not the correctness
// mechanism (the lease is).

const TS = "BIGINT"; // epoch-ms timestamps, passed as params for deterministic tests

// The metadata authority must stay aligned with the actual store. fsCasStore is sha256-only, so recording a
// sha512/blake3 address here would create a heap/ref/lease row that no store byte can ever back — an address the
// GC could "sweep" against nothing and that withCasObject could never resurrect. Fail closed at every entry point
// until a store advertises another algorithm (ContentAddressAlgorithm allows more at the TYPE level; the RUNTIME
// contract is sha256 today).
function assertSha256(address: ContentAddress): void {
  if (address.algorithm !== "sha256") throw new Error(`cas-metadata: only sha256 addresses are supported today (got '${address.algorithm}')`);
  // ALSO validate the digest shape: a malformed digest admitted here would create a heap/ref/lease row the store
  // later rejects during sweep/reuse — fail closed at the entry point instead (consistency with fsCasStore).
  if (typeof address.digest !== "string" || !/^[a-fA-F0-9]{64}$/.test(address.digest)) throw new Error(`cas-metadata: invalid sha256 digest '${address.digest}' (must be 64 hex chars)`);
}

/** Create the three CAS-metadata tables if absent. Idempotent. Run once against the authority's SqlConn. */
export async function initCasMetadata(conn: SqlConn): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS cas_object (
    algorithm     VARCHAR NOT NULL,
    digest        VARCHAR NOT NULL,
    size_bytes    ${TS},
    state         VARCHAR NOT NULL DEFAULT 'committed',  -- committed | tombstoned | deleted
    committed_at  ${TS} NOT NULL,
    tombstoned_at ${TS},
    PRIMARY KEY (algorithm, digest))`);
  await conn.run(`CREATE TABLE IF NOT EXISTS cas_ref (
    ref_id     VARCHAR NOT NULL,   -- the referrer's identity (run id, artifact name, url-hash, pin label)
    ref_type   VARCHAR NOT NULL,   -- run | artifact | remote_index | fs_version | manual_pin
    algorithm  VARCHAR NOT NULL,
    digest     VARCHAR NOT NULL,
    created_at ${TS} NOT NULL,
    expires_at ${TS},               -- NULL = durable; else a TTL'd reference
    PRIMARY KEY (ref_id, ref_type, algorithm, digest))`);
  await conn.run(`CREATE TABLE IF NOT EXISTS cas_lease (
    lease_id   VARCHAR NOT NULL PRIMARY KEY,
    holder     VARCHAR NOT NULL,
    algorithm  VARCHAR NOT NULL,
    digest     VARCHAR NOT NULL,
    created_at ${TS} NOT NULL,
    expires_at ${TS} NOT NULL)`);
}

/** Record a stored object as `committed` (idempotent — content-addressed, so a re-record is a no-op). Call right
 *  after `cas.put`. A previously tombstoned/deleted address that is written again is resurrected to committed. */
export async function recordCasObject(conn: SqlConn, address: ContentAddress, sizeBytes: number | null, nowMs: number): Promise<void> {
  assertSha256(address);
  await conn.run(
    `INSERT INTO cas_object (algorithm, digest, size_bytes, state, committed_at, tombstoned_at)
     VALUES (?, ?, ?, 'committed', ?, NULL)
     ON CONFLICT (algorithm, digest) DO UPDATE SET size_bytes = excluded.size_bytes, state = 'committed', committed_at = excluded.committed_at, tombstoned_at = NULL`,
    [address.algorithm, address.digest.toLowerCase(), sizeBytes, nowMs], // lowercase: CAS files/paths are lowercase, so refs/leases/objects must compare case-consistently
  ); // resurrect refreshes committed_at too, else the revived object is immediately mark-eligible again
}

export interface CasRefSpec { refId: string; refType: string; address: ContentAddress; expiresAt?: number | null; }

/** Add a durable (or TTL'd) reference — a ROOT. Idempotent on (ref_id, ref_type, algorithm, digest); a repeat
 *  refreshes expires_at. This is how a retained run / captured artifact / remote-index entry roots its bytes. */
export async function addCasRef(conn: SqlConn, ref: CasRefSpec, nowMs: number): Promise<void> {
  assertSha256(ref.address);
  await conn.run(
    `INSERT INTO cas_ref (ref_id, ref_type, algorithm, digest, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (ref_id, ref_type, algorithm, digest) DO UPDATE SET expires_at = excluded.expires_at`,
    [ref.refId, ref.refType, ref.address.algorithm, ref.address.digest.toLowerCase(), nowMs, ref.expiresAt ?? null], // lowercase: match the lowercase CAS files so a ref actually protects its bytes
  );
}

/** Drop every reference held by a referrer (e.g. when a run is pruned, release ITS roots). The bytes then become
 *  GC-eligible only if no OTHER ref/lease holds them — exactly the shared-safe behaviour. */
export async function dropCasRefs(conn: SqlConn, refId: string): Promise<{ dropped: number }> {
  const before = await conn.all<{ n: bigint }>(`SELECT count(*) n FROM cas_ref WHERE ref_id = ?`, [refId]);
  await conn.run(`DELETE FROM cas_ref WHERE ref_id = ?`, [refId]);
  return { dropped: Number(before[0]?.n ?? 0) };
}

/** Replace one referrer's exact root set for a ref type. New refs are inserted before stale refs are removed, so a
 * crash can over-root but not unroot the newly committed set. */
export async function replaceCasRefs(conn: SqlConn, refId: string, refType: string, refs: readonly Omit<CasRefSpec, "refId" | "refType">[], nowMs: number): Promise<void> {
  const unique = new Map<string, Omit<CasRefSpec, "refId" | "refType">>();
  for (const ref of refs) {
    assertSha256(ref.address);
    unique.set(`${ref.address.algorithm}:${ref.address.digest.toLowerCase()}`, {
      ...ref,
      address: { ...ref.address, digest: ref.address.digest.toLowerCase() },
    });
  }
  for (const ref of unique.values()) await addCasRef(conn, { refId, refType, ...ref }, nowMs);
  const kept = [...unique.values()];
  if (kept.length === 0) {
    await conn.run(`DELETE FROM cas_ref WHERE ref_id = ? AND ref_type = ?`, [refId, refType]);
    return;
  }
  const keepSql = kept.map(() => `(algorithm = ? AND digest = ?)`).join(" OR ");
  const params = kept.flatMap((r) => [r.address.algorithm, r.address.digest]);
  await conn.run(
    `DELETE FROM cas_ref WHERE ref_id = ? AND ref_type = ? AND NOT (${keepSql})`,
    [refId, refType, ...params],
  );
}

/** Acquire a lease over an address for `ttlMs`. Returns the lease id (release/renew with it). A leased object is
 *  retained by GC regardless of refs — this is the primitive a writer takes BEFORE reusing existing bytes. */
export async function acquireCasLease(conn: SqlConn, holder: string, address: ContentAddress, ttlMs: number, nowMs: number): Promise<string> {
  assertSha256(address);
  const leaseId = randomUUID();
  await conn.run(
    `INSERT INTO cas_lease (lease_id, holder, algorithm, digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [leaseId, holder, address.algorithm, address.digest.toLowerCase(), nowMs, nowMs + ttlMs], // lowercase: consistent with the stored objects/refs
  );
  return leaseId;
}

/** Extend a held lease. */
export async function renewCasLease(conn: SqlConn, leaseId: string, ttlMs: number, nowMs: number): Promise<void> {
  await conn.run(`UPDATE cas_lease SET expires_at = ? WHERE lease_id = ?`, [nowMs + ttlMs, leaseId]);
}

/** Release a held lease (idempotent). */
export async function releaseCasLease(conn: SqlConn, leaseId: string): Promise<void> {
  await conn.run(`DELETE FROM cas_lease WHERE lease_id = ?`, [leaseId]);
}

/** The safe REUSE protocol. Take a lease, then re-check the object's state under it:
 *   - `committed`  -> live: run `onHit` (e.g. materialize from cas.pathFor) and return { hit: true, result }.
 *   - `tombstoned` -> a mark already flagged it but the bytes are NOT yet swept (still within grace) and we now
 *                     hold a lease -> RESURRECT to committed and treat as a hit.
 *   - `deleted`    -> the bytes are gone -> a true miss; return { hit: false } (caller re-fetches/re-computes).
 *  The lease is always released. This is what makes reuse-from-a-shared-CAS race-free against a concurrent GC. */
export async function withCasObject<R>(
  conn: SqlConn,
  address: ContentAddress,
  holder: string,
  ttlMs: number,
  onHit: () => Promise<R>,
  nowMs: number = Date.now(),
): Promise<{ hit: boolean; result?: R }> {
  const leaseId = await acquireCasLease(conn, holder, address, ttlMs, nowMs);
  try {
    const rows = await conn.all<{ state: string }>(
      `SELECT state FROM cas_object WHERE algorithm = ? AND digest = ?`,
      [address.algorithm, address.digest.toLowerCase()],
    );
    const state = rows[0]?.state;
    // `deleting` = the sweeper has atomically CLAIMED this object for byte removal (it saw no live lease at claim
    // time) -> its bytes are going away, treat as a miss. `deleted`/absent are misses too. Only `tombstoned`/
    // `committed` are safe to hold under our lease.
    if (state === "deleted" || state === "deleting" || state === undefined) return { hit: false };
    if (state === "tombstoned") {
      // bytes still present (not swept yet) and we hold a lease -> revive rather than re-fetch. REFRESH committed_at
      // too (same invariant as recordCasObject's resurrect): a revived object keeping its OLD committed_at is
      // immediately mark-eligible again — the next gcMark (committed_at < cutoff, and our lease may already be gone)
      // would re-tombstone it and a sweep could delete the just-reused bytes before a durable ref roots them.
      await conn.run(`UPDATE cas_object SET state = 'committed', tombstoned_at = NULL, committed_at = ? WHERE algorithm = ? AND digest = ?`, [nowMs, address.algorithm, address.digest.toLowerCase()]);
    }
    return { hit: true, result: await onHit() };
  } finally {
    await releaseCasLease(conn, leaseId);
  }
}

/** MARK: tombstone every committed object older than `cutoffMs` that has NO live ref and NO live lease. Returns
 *  the addresses tombstoned. The anti-join IS the GC — completeness comes from the rows, not a filesystem scan. */
export async function gcMark(conn: SqlConn, opts: { cutoffMs: number; nowMs: number }): Promise<ContentAddress[]> {
  const marked = await conn.all<{ algorithm: string; digest: string }>(
    `UPDATE cas_object SET state = 'tombstoned', tombstoned_at = ?
     WHERE state = 'committed' AND committed_at < ?
       AND NOT EXISTS (SELECT 1 FROM cas_ref r
                       WHERE r.algorithm = cas_object.algorithm AND r.digest = cas_object.digest
                         AND (r.expires_at IS NULL OR r.expires_at > ?))
       AND NOT EXISTS (SELECT 1 FROM cas_lease l
                       WHERE l.algorithm = cas_object.algorithm AND l.digest = cas_object.digest
                         AND l.expires_at > ?)
     RETURNING algorithm, digest`,
    [opts.nowMs, opts.cutoffMs, opts.nowMs, opts.nowMs],
  );
  return marked.map((m) => ({ algorithm: m.algorithm as ContentAddress["algorithm"], digest: m.digest }));
}

/** SWEEP: delete the bytes of every object tombstoned longer than `graceMs` ago, then mark it `deleted`. The
 *  grace is the window in which an in-flight `withCasObject` lease can still resurrect a tombstoned object before
 *  its bytes vanish. Expired leases are reaped here too (housekeeping). Returns the addresses whose bytes were
 *  removed. */
export async function gcSweep(conn: SqlConn, cas: CasStore, opts: { graceMs: number; nowMs: number }): Promise<ContentAddress[]> {
  await conn.run(`DELETE FROM cas_lease WHERE expires_at <= ?`, [opts.nowMs]); // reap expired leases
  // ATOMICALLY CLAIM the due objects: transition tombstoned -> `deleting` in ONE statement that RE-CHECKS no live
  // ref and no live lease. This closes the sweep race: a withCasObject lease (or a new cas_ref) that lands BEFORE
  // the claim is seen by the NOT EXISTS -> the object is not claimed (stays tombstoned, gets resurrected); one that
  // lands AFTER sees state=`deleting` -> a miss. Only the rows this statement returned are deleted, so we never
  // remove bytes another writer just re-rooted/leased between a select and the delete (the old SELECT-then-loop bug).
  const claimed = await conn.all<{ algorithm: string; digest: string }>(
    `UPDATE cas_object SET state = 'deleting'
     WHERE state = 'tombstoned' AND tombstoned_at <= ?
       AND NOT EXISTS (SELECT 1 FROM cas_ref r
                       WHERE r.algorithm = cas_object.algorithm AND r.digest = cas_object.digest
                         AND (r.expires_at IS NULL OR r.expires_at > ?))
       AND NOT EXISTS (SELECT 1 FROM cas_lease l
                       WHERE l.algorithm = cas_object.algorithm AND l.digest = cas_object.digest
                         AND l.expires_at > ?)
     RETURNING algorithm, digest`,
    [opts.nowMs - opts.graceMs, opts.nowMs, opts.nowMs],
  );
  const swept: ContentAddress[] = [];
  for (const { algorithm, digest } of claimed) {
    const address: ContentAddress = { algorithm: algorithm as ContentAddress["algorithm"], digest };
    try {
      await cas.remove(address);
    } catch (e) {
      // the physical remove FAILED (permissions, a transient mount, an object-store outage) — the BYTES ARE STILL
      // PRESENT. Revert to `tombstoned` so a later sweep retries (don't orphan it in `deleting`), then surface it.
      await conn.run(`UPDATE cas_object SET state = 'tombstoned' WHERE algorithm = ? AND digest = ? AND state = 'deleting'`, [algorithm, digest]);
      throw e;
    }
    // The bytes are GONE now, so the row MUST read `deleted` — AUTHORITATIVELY, not `WHERE state='deleting'`. On a
    // shared store a concurrent recordCasObject/withCasObject-resurrect can flip the row to `committed` between our
    // atomic claim and this point (its cas.put returned early on bytes we then removed); a conditional update would
    // no-op there, leaving a PHANTOM `committed` row over deleted bytes. Forcing `deleted` makes the metadata match
    // reality: a later reader sees `deleted` -> MISS -> re-fetch (read sites also guard with cas.has), never a wrong
    // result. (Residual under concurrency: a cas_ref added in that window dangles at a deleted object — harmless, the
    // cas.has guard catches it; a fully concurrent-safe reput needs epoch fencing, a tracked refinement. If THIS
    // update itself errors the row stays `deleting`, still a safe withCasObject MISS.)
    await conn.run(`UPDATE cas_object SET state = 'deleted' WHERE algorithm = ? AND digest = ?`, [algorithm, digest]);
    swept.push(address);
  }
  return swept;
}

/** Full mark+sweep over the metadata authority — the distributed-safe collectGarbage. `cutoffMs`/`graceMs`
 *  default to `nowMs - minAgeMs` and `minAgeMs` respectively (one knob: the longest possible in-flight run). */
export async function gcMarkSweep(
  conn: SqlConn,
  cas: CasStore,
  opts: { minAgeMs: number; nowMs?: number; cutoffMs?: number; graceMs?: number },
): Promise<{ marked: ContentAddress[]; swept: ContentAddress[] }> {
  const nowMs = opts.nowMs ?? Date.now();
  const marked = await gcMark(conn, { cutoffMs: opts.cutoffMs ?? nowMs - opts.minAgeMs, nowMs });
  const swept = await gcSweep(conn, cas, { graceMs: opts.graceMs ?? opts.minAgeMs, nowMs });
  return { marked, swept };
}
