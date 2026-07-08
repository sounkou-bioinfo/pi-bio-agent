import { resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { parseGraphWindowContinuation, queryGraphWindow, type GraphQueryWindowOptions } from "../duckdb/graph-window.js";
import { parseFlags } from "./run.js";

export interface GraphWindowCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = [
  "usage: pi-bio-agent graph-window --db <path|:memory:> --start <node-id> [--table bio_edges] [--direction out|in|both] [--predicates p1,p2] [--limit n] [--offset n]",
  "       pi-bio-agent graph-window --db <path|:memory:> --continuation <graph-window:...>",
  "  Pages an existing DuckDB graph table with columns from_id, predicate, to_id. Use this for ledger/KG inspection without loading a whole neighborhood.",
].join("\n");

function parseIntegerFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

function parseOptions(flags: Record<string, string>): GraphQueryWindowOptions & { dbPath: string } {
  const known = new Set(["db", "table", "start", "start-id", "direction", "predicates", "limit", "offset", "continuation"]);
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unknown flag(s) for 'graph-window': ${unknown.map((k) => `--${k}`).join(", ")}`);
  const empty = Object.entries(flags).filter(([, v]) => v === "").map(([k]) => k);
  if (empty.length) throw new Error(`flag(s) with an empty value: ${empty.map((k) => `--${k}`).join(", ")}`);
  if (!flags.db) throw new Error("graph-window requires --db <path|:memory:>");
  if (flags.continuation !== undefined) {
    const conflicts = ["table", "start", "start-id", "direction", "predicates", "limit", "offset"].filter((k) => flags[k] !== undefined);
    if (conflicts.length) throw new Error(`--continuation cannot be combined with ${conflicts.map((k) => `--${k}`).join(", ")}`);
    return { dbPath: flags.db, ...parseGraphWindowContinuation(flags.continuation) };
  }
  if (flags.start !== undefined && flags["start-id"] !== undefined && flags.start !== flags["start-id"]) {
    throw new Error("--start and --start-id disagree");
  }
  const startId = flags.start ?? flags["start-id"];
  if (!startId) throw new Error("graph-window requires --start <node-id>");
  const direction = flags.direction ?? "out";
  if (direction !== "out" && direction !== "in" && direction !== "both") throw new Error("--direction must be out, in, or both");
  return {
    dbPath: flags.db,
    startId,
    table: flags.table,
    direction,
    predicates: flags.predicates?.split(",").map((p) => p.trim()).filter(Boolean),
    limit: parseIntegerFlag(flags.limit, "limit"),
    offset: parseIntegerFlag(flags.offset, "offset"),
  };
}

export async function mainGraphWindow(argv: string[], deps: GraphWindowCliDeps): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.err(USAGE);
    return 0;
  }
  let opts: GraphQueryWindowOptions & { dbPath: string };
  try {
    opts = parseOptions(parseFlags(argv));
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    deps.err(USAGE);
    return 2;
  }

  const dbPath = opts.dbPath === ":memory:" ? ":memory:" : resolve(deps.cwd, opts.dbPath);
  let instance: Awaited<ReturnType<typeof DuckDBInstance.create>> | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    instance = await DuckDBInstance.create(dbPath);
    connection = await instance.connect();
    const { dbPath: _dbPath, ...windowOpts } = opts;
    const window = await queryGraphWindow(duckdbNodeConn(connection), windowOpts);
    deps.out(JSON.stringify(window, null, 2));
    return 0;
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    connection?.closeSync();
    instance?.closeSync();
  }
}
