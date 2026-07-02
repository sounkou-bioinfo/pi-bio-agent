import { DuckDBInstance } from "@duckdb/node-api";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { SqlConn } from "../core/ports.js";
import { duckdbNodeConn } from "../duckdb/node-api.js";
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
 * - **across runs of one project**: the default project-local file — every run opens it, so memory/facts persist
 *   and accumulate (DuckDB is a process-exclusive writer, so concurrent runs serialize; that is the correct
 *   default for a single project);
 * - **across projects / users**: point `path` at a shared location (a shared mount, a per-user global store);
 * - **concurrent / cross-host / cross-agent**: the process-exclusive-writer lock is lifted by a DuckDB SERVER —
 *   a ducknng-served DuckDB (`ducknng_run_rpc`, exec opt-in) or a duckdb quack server — one writer that many
 *   clients read/write through concurrently; or share immutable snapshots by digest via CAS. Because every memory
 *   row carries its author (`source`) and an as-of time, a shared live store stays trustworthy and consistent;
 *   access stays host-gated (ducknng mTLS / peer-allowlists / exec opt-in). This `conn` is the seam: the host
 *   injects a local file today or a server-backed connection when it wants a shared live store.
 */
export interface BioStore {
  conn: SqlConn;
  /** Release the DuckDB handle. On the serverless local-file default DuckDB is a process-exclusive writer, so a
   *  project's runs SHARE by open → write → close in sequence; a caller must close to let the next run open it.
   *  (Concurrency is not a serialize-forever limit — a ducknng/quack server lifts it; see openBioStore.) */
  close(): void;
}

export async function openBioStore(cwd: string, opts: { path?: string } = {}): Promise<BioStore> {
  const path = opts.path ?? bioStorePath(cwd);
  await fs.mkdir(dirname(path), { recursive: true }); // the store file's OWN parent — works for a custom opts.path too
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  const conn = duckdbNodeConn(connection);
  await createBioObservationSchema(conn, { ifNotExists: true });
  return {
    conn,
    close: () => {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

/** True iff `err` is DuckDB refusing to open the local-file store because ANOTHER PROCESS holds the write lock
 *  (DuckDB is a process-exclusive writer). This is the EXPECTED contention between concurrent agents on the
 *  file store — distinct from a real failure (corruption, permissions, disk). Server-backed stores never raise it. */
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
 * - `openBioStore` — the OWNER's open; throws on a lock conflict (a memory WRITE must not be silently dropped).
 * - `tryOpenBioStore` — a best-effort open; a lock conflict returns null (the caller degrades), real errors throw.
 * - a SERVER-backed store (host injects via the extension's `openStore` seam — ducknng `run_rpc` / quack) — the
 *   correct answer for genuine concurrency: one server is the single writer, many clients connect, no file lock.
 */
export async function tryOpenBioStore(cwd: string, opts: { path?: string } = {}): Promise<BioStore | null> {
  try {
    return await openBioStore(cwd, opts);
  } catch (err) {
    if (isBioStoreLocked(err)) return null;
    throw err;
  }
}
