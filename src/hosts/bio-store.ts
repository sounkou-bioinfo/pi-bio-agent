import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { SqlConn } from "../core/ports.js";
import { duckdbNodeConn, openDuckDbInstance, withDuckDbFileInitialization } from "../duckdb/node-api.js";
import { createBioObservationSchema } from "../duckdb/observations.js";

// THE one store. Memory is NOT a separate database: facts, compute-status, jobs, activation AND memory are all
// rows in the SAME `bio_observations` table, in the SAME DuckDB where the graph (`bio_edges_as_of` /
// `entailed_edge_as_of`) is materialized. That is the whole point of the unification — one append-only ledger, one
// as-of clock, one graph closure. A separate `memory.duckdb` would re-fragment it and make a cross-domain walk
// (a memory note -> an ontology term -> a fact, in ONE closure) impossible without cross-file ATTACH/joins.
export function bioStorePath(cwd: string): string {
  return join(cwd, ".pi", "bio-agent", "store.duckdb");
}

/**
 * Open (creating if needed) the host's single persistent store and ensure the observation schema. The host owns
 * this connection and passes it to memory/fact/job recorders alike — none of them owns a private database.
 *
 * SHARING is a choice of WHERE this store lives, made by the host (the library records; the host decides):
 * - **across runs of one project / one process**: the default project-local file — every open receives a new
 *   connection to one process-cached DuckDB instance, so concurrent Pi hooks/tools cannot attach the same file
 *   through independent instances and silently lose or corrupt writes;
 * - **across projects / users in one process**: point `path` at a shared location; the same resolved file path uses
 *   that process cache and retains attributed rows;
 * - **cross-process / cross-host / cross-agent**: another process still cannot open the local file while this one
 *   owns it. Use a DuckDB SERVER — a ducknng-served DuckDB (`ducknng_run_rpc`, exec opt-in) or equivalent — as the
 *   one writer that many clients reach concurrently; or share immutable snapshots by digest via CAS. Because every
 *   memory row carries its author (`source`) and an as-of time, a shared live store stays attributed. This `conn` is
 *   the seam: the host injects a local file today or a server-backed connection for multi-process sharing.
 */
export interface BioStore {
  conn: SqlConn;
  /** Release this connection and its cached-instance handle. Other same-process opens may remain live; callers must
   *  still close promptly so the native cache can release the file when the final handle closes. */
  close(): void;
}

export async function openBioStore(cwd: string, opts: { path?: string } = {}): Promise<BioStore> {
  const path = opts.path ?? bioStorePath(cwd);
  await fs.mkdir(dirname(path), { recursive: true }); // the store file's OWN parent — works for a custom opts.path too
  // DuckDB's node-api contract is explicit: multiple instances in one process must not attach the same database.
  // openDuckDbInstance uses one process-wide native instance cache for file paths while keeping :memory: isolated.
  const instance = await openDuckDbInstance(path);
  // Fail closed WITHOUT leaking the cached handle. Schema DDL is serialized per file because concurrent
  // CREATE ... IF NOT EXISTS statements on separate connections can still catalog-conflict.
  let connection: Awaited<ReturnType<typeof instance.connect>> | undefined;
  try {
    connection = await instance.connect();
    const conn = duckdbNodeConn(connection);
    await withDuckDbFileInitialization(path, () => createBioObservationSchema(conn, { ifNotExists: true }));
    return buildStore(conn, connection, instance);
  } catch (err) {
    connection?.closeSync();
    instance.closeSync();
    throw err;
  }
}

function buildStore(conn: SqlConn, connection: { closeSync(): void }, instance: { closeSync(): void }): BioStore {
  return {
    conn,
    close: () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/** True iff `err` is DuckDB refusing to open the local-file store because ANOTHER PROCESS holds the write lock.
 * Same-process opens share a cached instance and do not use this path. This remains distinct from a real failure
 * (corruption, permissions, disk); server-backed stores never raise it. */
export function isBioStoreLocked(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Could not set lock|Conflicting lock|lock on file/i.test(m);
}

/**
 * Non-throwing open for BEST-EFFORT readers/loggers (the recall index, the run-log): returns null when another
 * process holds the file store's write lock, so a concurrent agent DEGRADES instead of failing. A REAL error
 * (corruption/permissions/disk) still throws — it must not be silently swallowed.
 *
 * The three access modes, documented in one place:
 * - `openBioStore` — a connection to the process-cached local instance; throws on a cross-process lock conflict.
 * - `tryOpenBioStore` — the same process-cached path, but a cross-process lock conflict returns null; real errors
 *   still throw.
 * - a SERVER-backed store (host injects via the extension's `openStore` seam — ducknng `run_rpc` / equivalent) —
 *   the correct answer for multi-process/multi-host concurrency: one server is the writer authority.
 */
export async function tryOpenBioStore(cwd: string, opts: { path?: string } = {}): Promise<BioStore | null> {
  try {
    return await openBioStore(cwd, opts);
  } catch (err) {
    if (isBioStoreLocked(err)) return null;
    throw err;
  }
}
