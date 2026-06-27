import { studyNoteGraph } from "../core/study.js";
import { createBioGraphSchema, syncStudyNoteGraph, type KgSqlConn, type SyncStudyNoteGraphOptions, type SyncStudyNoteGraphResult } from "../duckdb/kg-sync.js";
import { readStudyNotes } from "./pi-project.js";

export interface SyncProjectStudyNotesOptions extends SyncStudyNoteGraphOptions {
  /** Create the `bio_nodes`/`bio_edges` schema (IF NOT EXISTS) before syncing. Default false: the tables are assumed to exist. */
  createSchema?: boolean;
}

/**
 * Project-level orchestration: read the project's study notes under `cwd`, project them to a memory
 * graph, and sync that into DuckDB through the given connection. The one call ties the file layer to the
 * graph layer. Explicit args only — dry-run by default, writing needs `allowWrite`, and schema creation
 * is opt-in via `createSchema`; nothing is read from ambient process state.
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
