import { studyNoteGraph } from "../core/study.js";
import { createBioGraphSchema, syncStudyNoteGraph, type KgSqlConn, type SyncStudyNoteGraphOptions, type SyncStudyNoteGraphResult } from "../duckdb/kg-sync.js";
import { readStudyNotes } from "./pi-project.js";

export interface SyncProjectStudyNotesOptions extends SyncStudyNoteGraphOptions {
  /**
   * Ensure the `bio_nodes`/`bio_edges` schema exists (`CREATE TABLE/INDEX IF NOT EXISTS`) before syncing.
   * Default false. This is **DDL and runs even under `dryRun`** — `dryRun` governs only the memory
   * subgraph *row* writes, not schema setup. For a dry run that performs no database writes, leave this
   * false (the schema must already exist); note that a dry run still *reads* (it SELECTs counts).
   */
  createSchema?: boolean;
}

/**
 * Project-level orchestration: read the project's study notes under `cwd`, project them to a memory
 * graph, and sync that into DuckDB through the given connection. The one call ties the file layer to the
 * graph layer. Explicit args only; nothing is read from ambient process state.
 *
 * Two independent effect axes: `createSchema` controls schema/index DDL (idempotent, runs even in
 * dry-run); `dryRun`/`allowWrite` control the memory subgraph row sync (dry-run by default, writing
 * needs `allowWrite`).
 */
export async function syncProjectStudyNotes(
  conn: KgSqlConn,
  cwd: string,
  options: SyncProjectStudyNotesOptions = {},
): Promise<SyncStudyNoteGraphResult> {
  const { createSchema, ...syncOptions } = options;
  if (createSchema) await createBioGraphSchema(conn, { ifNotExists: true });
  const notes = await readStudyNotes(cwd);
  return syncStudyNoteGraph(conn, studyNoteGraph(notes), syncOptions);
}
