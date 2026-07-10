import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { openBioStore } from "../hosts/bio-store.js";
import { fsCasStore } from "../hosts/fs-cas.js";
import { ingestSessionJsonl, type SessionJsonlFormat } from "../hosts/session-ingest.js";
import { parseFlags } from "./run.js";

export interface SessionCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const SESSION_USAGE = [
  "usage: pi-bio-agent session import <session.jsonl> [--format pi|codex] [--db <path>] [--cas-root <dir>]",
  "       [--session-id <id>] [--parent-session-id <id>] [--source <actor>]",
  "Imports a persisted Pi session or Codex rollout into the observation ledger and retains the original JSONL in CAS.",
  "Without --format, the first JSONL object is used to distinguish Pi from Codex.",
].join("\n");

function localPath(cwd: string, value: string): string {
  return value === ":memory:" ? value : resolve(cwd, value);
}

export async function mainSession(argv: string[], deps: SessionCliDeps): Promise<number> {
  const [command, sessionPath, ...rest] = argv;
  if (command === "--help" || command === "-h") {
    deps.out(SESSION_USAGE);
    return 0;
  }
  if (command !== "import" || !sessionPath || sessionPath.startsWith("--")) {
    deps.err(SESSION_USAGE);
    return 2;
  }

  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest);
    const known = new Set(["format", "db", "cas-root", "session-id", "parent-session-id", "source"]);
    const unknown = Object.keys(flags).filter((key) => !known.has(key));
    if (unknown.length > 0) throw new Error(`unknown session import flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
    const empty = Object.entries(flags).filter(([, value]) => value.length === 0).map(([key]) => key);
    if (empty.length > 0) throw new Error(`flag(s) with an empty value: ${empty.map((key) => `--${key}`).join(", ")}`);
    if (flags.format && flags.format !== "pi" && flags.format !== "codex") throw new Error("--format must be 'pi' or 'codex'");
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    deps.err(SESSION_USAGE);
    return 2;
  }

  const dbPath = flags.db ? localPath(deps.cwd, flags.db) : join(deps.cwd, ".pi", "bio-agent", "store.duckdb");
  const casRoot = flags["cas-root"] ? resolve(deps.cwd, flags["cas-root"]) : join(deps.cwd, ".pi", "bio-agent", "cas");
  const resolvedSessionPath = resolve(deps.cwd, sessionPath);
  try {
    const stat = await fs.stat(resolvedSessionPath);
    if (!stat.isFile()) throw new Error("not a regular file");
  } catch (error) {
    deps.err(`session import source is not readable: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  let store: Awaited<ReturnType<typeof openBioStore>> | undefined;
  try {
    store = await openBioStore(deps.cwd, { path: dbPath });
    const result = await ingestSessionJsonl({
      conn: store.conn,
      cas: fsCasStore(casRoot),
      casMetadata: { conn: store.conn },
      sessionPath: resolvedSessionPath,
      format: flags.format as SessionJsonlFormat | undefined,
      sessionId: flags["session-id"],
      parentSessionId: flags["parent-session-id"],
      source: flags.source ?? "cli:session-import",
    });
    deps.out(JSON.stringify({ ...result, dbPath, casRoot }, null, 2));
    return 0;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store?.close();
  }
}
