import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { HostCapabilityReceipt, RunReplaySpec } from "../core/reproducibility.js";
import type { SqlConn } from "../core/ports.js";
import { bioStorePath, openBioStore } from "../hosts/bio-store.js";
import { fsCasStore } from "../hosts/fs-cas.js";
import { cappedFetchLike, DEFAULT_MAX_RESPONSE_BYTES } from "../hosts/network.js";
import { reproduceRun } from "../hosts/reproduce.js";
import { nodeComputeRunner } from "../process/node-compute-runner.js";
import { duckDbPathsReferToSameFile } from "../duckdb/node-api.js";
import { parseFlags, splitSqlStatements } from "./run.js";

export interface ReproduceCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  signal?: AbortSignal;
}

const USAGE = [
  "usage: pi-bio-agent reproduce <replay.json> [--db <path|:memory:>] [--cas-root <dir>] [--compute local] [--network fetch]",
  "       [--max-response-bytes <n>]",
  "       [--init-sql <sql>] [--duckdb-config-file <json>] [--protected-bindings-file <json>]",
  "       [--protected-variables a,b] [--host-receipts-file <json>] [--remote-cache-scope <scope>]",
  "       [--ledger <path|auto> [--author name]]",
  "Re-executes the replay against a fresh database and compares source, result, and environment digests.",
].join("\n");

async function readJson<T>(cwd: string, path: string, label: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(resolve(cwd, path), "utf8")) as T;
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function mainReproduce(argv: string[], deps: ReproduceCliDeps): Promise<number> {
  const [replayPath, ...rest] = argv;
  if (replayPath === "--help" || replayPath === "-h") {
    deps.out(USAGE);
    return 0;
  }
  if (!replayPath || replayPath.startsWith("--")) {
    deps.err(USAGE);
    return 2;
  }

  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest);
    const known = new Set(["db", "cas-root", "compute", "network", "max-response-bytes", "init-sql", "duckdb-config-file", "protected-bindings-file", "protected-variables", "host-receipts-file", "remote-cache-scope", "ledger", "author"]);
    const unknown = Object.keys(flags).filter((key) => !known.has(key));
    if (unknown.length > 0) throw new Error(`unknown reproduce flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
    const empty = Object.entries(flags).filter(([, value]) => value.length === 0).map(([key]) => key);
    if (empty.length > 0) throw new Error(`flag(s) with an empty value: ${empty.map((key) => `--${key}`).join(", ")}`);
    if (flags.compute && flags.compute !== "local") throw new Error("--compute currently accepts only 'local'");
    if (flags.network && flags.network !== "fetch") throw new Error("--network currently accepts only 'fetch'");
    if (flags["max-response-bytes"] && flags.network !== "fetch") throw new Error("--max-response-bytes requires --network fetch");
    if (flags["max-response-bytes"] && (!Number.isSafeInteger(Number(flags["max-response-bytes"])) || Number(flags["max-response-bytes"]) < 1)) throw new Error("--max-response-bytes must be a positive safe integer");
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    deps.err(USAGE);
    return 2;
  }

  let ledger: { conn: SqlConn; close: () => void } | undefined;
  try {
    const replay = await readJson<RunReplaySpec>(deps.cwd, replayPath, "replay");
    const casRoot = flags["cas-root"]
      ? resolve(deps.cwd, flags["cas-root"])
      : replay.resultDigest ? join(deps.cwd, ".pi", "bio-agent", "cas") : undefined;
    const duckdbConfig = flags["duckdb-config-file"]
      ? await readJson<Record<string, string>>(deps.cwd, flags["duckdb-config-file"], "duckdb config") : undefined;
    const protectedSessionBindings = flags["protected-bindings-file"]
      ? await readJson<Record<string, unknown>>(deps.cwd, flags["protected-bindings-file"], "protected bindings") : undefined;
    const hostCapabilityReceipts = flags["host-receipts-file"]
      ? await readJson<HostCapabilityReceipt[]>(deps.cwd, flags["host-receipts-file"], "host receipts") : undefined;
    const protectedSessionVariables = flags["protected-variables"]?.split(",").map((name) => name.trim()).filter(Boolean);
    const duckdbInitSql = flags["init-sql"] ? splitSqlStatements(flags["init-sql"]) : undefined;
    const dbPath = flags.db ?? ":memory:";
    if (flags.ledger) {
      const ledgerPath = flags.ledger === "auto" ? bioStorePath(deps.cwd) : resolve(deps.cwd, flags.ledger);
      if (dbPath !== ":memory:" && await duckDbPathsReferToSameFile(resolve(deps.cwd, dbPath), ledgerPath)) {
        throw new Error("--ledger must not refer to the reproduction --db file; evidence and execution require separate DuckDB catalogs");
      }
      ledger = await openBioStore(deps.cwd, { path: ledgerPath });
    }

    const result = await reproduceRun({
      cwd: deps.cwd,
      replay,
      dbPath,
      ...(casRoot ? { cas: fsCasStore(casRoot) } : {}),
      ...(flags.compute === "local" ? { compute: { runner: nodeComputeRunner() } } : {}),
      ...(flags.network === "fetch" ? { network: { fetch: cappedFetchLike(globalThis.fetch, Number(flags["max-response-bytes"] ?? DEFAULT_MAX_RESPONSE_BYTES)) } } : {}),
      duckdbInitSql,
      duckdbConfig,
      protectedSessionBindings,
      protectedSessionVariables,
      hostCapabilityReceipts,
      remoteCacheScope: flags["remote-cache-scope"],
      signal: deps.signal,
      store: ledger?.conn,
      author: flags.author ?? "cli",
    });
    deps.out(JSON.stringify({ ...result, ...(casRoot ? { casRoot } : {}) }, null, 2));
    return result.reproduced && result.matched ? 0 : 1;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    ledger?.close();
  }
}
