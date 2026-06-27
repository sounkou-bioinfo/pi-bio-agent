import { parseArgs } from "node:util";
import { reportStudyNoteGraph, type KgSqlConn, type StudyNoteGraphReport, type SyncStudyNoteGraphResult } from "../duckdb/kg-sync.js";
import { syncProjectStudyNotes } from "../hosts/study-sync.js";

export interface NotesSyncArgs {
  command: "sync";
  db: string;
  write: boolean;
  createSchema: boolean;
  json: boolean;
}

export interface NotesReportArgs {
  command: "report";
  db: string;
  /** Always set: defaults to DEFAULT_NOTES_REPORT_LIMIT so the CLI never prints unbounded rows. */
  limit: number;
  json: boolean;
}

/** The CLI caps report rows by default so it can't flood output; raise with --limit N (counts stay exact). */
export const DEFAULT_NOTES_REPORT_LIMIT = 100;

export type NotesArgs = NotesSyncArgs | NotesReportArgs;

export const NOTES_USAGE = `pi-bio-agent notes <command>

Commands:
  sync    --db <path> [--write] [--create-schema] [--json]
  report  --db <path> [--limit <n>] [--json]

Reads study notes from .pi/bio-agent/study-notes under the current directory and projects
them into the memory subgraph (bio_nodes/bio_edges) of the given DuckDB database.

sync performs a dry run (reads counts, writes no rows) unless --write is passed.
--create-schema runs CREATE TABLE/INDEX IF NOT EXISTS even in a dry run.`;

/**
 * Pure: parse argv (after the `notes` token) into a typed command. Throws on bad input. Each command
 * gets its own option set, so an inapplicable flag (e.g. `report --write`, `sync --limit`) fails closed
 * with an "Unknown option" error rather than being silently ignored.
 */
export function parseNotesArgs(argv: string[]): NotesArgs {
  const [command, ...rest] = argv;
  const requireDb = (db: string | undefined): string => {
    if (!db) throw new Error(`--db <path> is required.\n\n${NOTES_USAGE}`);
    return db;
  };

  if (command === "sync") {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        db: { type: "string" },
        write: { type: "boolean", default: false },
        "create-schema": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
    });
    return { command, db: requireDb(values.db), write: values.write ?? false, createSchema: values["create-schema"] ?? false, json: values.json ?? false };
  }

  if (command === "report") {
    const { values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        db: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
    let limit = DEFAULT_NOTES_REPORT_LIMIT;
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit must be a non-negative integer, got '${values.limit}'`);
    }
    return { command, db: requireDb(values.db), limit, json: values.json ?? false };
  }

  throw new Error(`unknown notes command '${command ?? ""}'.\n\n${NOTES_USAGE}`);
}

function formatSync(r: SyncStudyNoteGraphResult): string {
  return [
    `notes sync — ${r.dryRun ? "DRY RUN (no row writes)" : "WROTE"}`,
    `  memory nodes:  ${r.nodesToDelete} existing → ${r.nodesToInsert} projected`,
    `  memory edges:  ${r.edgesToDelete} existing → ${r.edgesToInsert} projected`,
    `  dangling edges: ${r.danglingEdges}`,
    `  external inbound (blocks write): ${r.externalInboundEdges}`,
    r.dryRun ? "  (pass --write to apply)" : "",
  ].filter(Boolean).join("\n");
}

function formatEdgeRows(rows: StudyNoteGraphReport["danglingEdges"]): string[] {
  return rows.map((e) => `    - ${e.from} → ${e.to} (${e.predicate})`);
}

function formatReport(r: StudyNoteGraphReport): string {
  const lines = [
    "notes report",
    `  memory nodes: ${r.memoryNodes}`,
    `  memory edges: ${r.memoryEdges}`,
    `  dangling links: ${r.danglingEdgeCount}`,
    ...formatEdgeRows(r.danglingEdges),
  ];
  if (r.danglingEdges.length < r.danglingEdgeCount) lines.push(`    … ${r.danglingEdgeCount - r.danglingEdges.length} more (raise --limit)`);
  lines.push(`  external inbound edges: ${r.externalInboundEdgeCount}`, ...formatEdgeRows(r.externalInboundEdges));
  if (r.externalInboundEdges.length < r.externalInboundEdgeCount) lines.push(`    … ${r.externalInboundEdgeCount - r.externalInboundEdges.length} more (raise --limit)`);
  return lines.join("\n");
}

/** Run a parsed command against an injected connection. Effectful via the connection only. */
export async function runNotesCommand(args: NotesArgs, deps: { conn: KgSqlConn; cwd: string }): Promise<{ data: SyncStudyNoteGraphResult | StudyNoteGraphReport; text: string }> {
  if (args.command === "sync") {
    const data = await syncProjectStudyNotes(deps.conn, deps.cwd, { createSchema: args.createSchema, dryRun: !args.write, allowWrite: args.write });
    return { data, text: formatSync(data) };
  }
  const data = await reportStudyNoteGraph(deps.conn, { limit: args.limit });
  return { data, text: formatReport(data) };
}

export interface NotesCliDeps {
  cwd: string;
  /** Open a `KgSqlConn` for the `--db` path. Injected so the command is testable without a real driver. */
  openConn: (db: string) => Promise<KgSqlConn>;
  out: (line: string) => void;
}

/** Top-level entry: parse → open connection → run → print. Returns a process exit code; never calls process.exit. */
export async function mainNotes(argv: string[], deps: NotesCliDeps): Promise<number> {
  let args: NotesArgs;
  try {
    args = parseNotesArgs(argv);
  } catch (error) {
    deps.out((error as Error).message);
    return 2;
  }
  let conn: KgSqlConn;
  try {
    conn = await deps.openConn(args.db);
  } catch (error) {
    deps.out(`failed to open --db '${args.db}': ${(error as Error).message}`);
    return 1;
  }
  try {
    const { data, text } = await runNotesCommand(args, { conn, cwd: deps.cwd });
    deps.out(args.json ? JSON.stringify(data, null, 2) : text);
    return 0;
  } catch (error) {
    deps.out(`error: ${(error as Error).message}`);
    return 1;
  }
}
