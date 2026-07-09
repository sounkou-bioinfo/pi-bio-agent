import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { SqlConn } from "../core/ports.js";
import type { HostCapabilityReceipt } from "../core/reproducibility.js";
import { runBioOperationFromManifest, runBioQueryFromManifest } from "../hosts/run-store.js";
import { openBioStore } from "../hosts/bio-store.js";
import { fsCasStore } from "../hosts/fs-cas.js";
import { cappedFetchLike, DEFAULT_MAX_RESPONSE_BYTES } from "../hosts/network.js";
import { nodeComputeRunner } from "../process/node-compute-runner.js";
import type { DucknngHttpProfileSpec } from "../duckdb/http-profiles.js";

// The `query` / `run` CLI engine — the substrate's actual value at a provider-agnostic entry point (not Pi-only).
// It wraps the SAME tested host functions the Pi extension uses (runBioQueryFromManifest / runBioOperationFromManifest),
// so the CLI and the agent share one code path. Effects remain opt-in: `--network fetch`, `--compute local`, and
// `--cas-root` compose the existing host ports explicitly; absent flags leave those resolvers unbound.
//
//   pi-bio-agent query <manifest.json> --db <path|:memory:> --sql "<read-only SQL>" [--resources a,b] [--run-id id]
//   pi-bio-agent run   <manifest.json> --db <path|:memory:> --operation <operationId>   [--run-id id]
//
// On success it prints the run response (runId/status/rowCount/runDir/artifacts) AND the result rows (result.json)
// as JSON; on a failed run it prints the error and returns exit code 1. Bindings pass agent params as session vars.

export interface RunCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  readStdin?: () => Promise<string>;
  signal?: AbortSignal;
}

/** Parse `--key value` and `--key=value` pairs after the positional manifest path. Repeated keys keep the last.
 *  Every flag here TAKES a value, so `--key value` consumes the next token even when it looks like a flag (a SQL
 *  value can legitimately start with `--`, e.g. a `-- comment`); use `--key=value` for any value that is itself
 *  ambiguous. */
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}' (expected --key value or --key=value)`);
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const key = a.slice(2, eq);
      if (!key) throw new Error(`invalid flag '${a}' (empty flag name)`);
      flags[key] = a.slice(eq + 1); // --key=value: value may start with --, contain spaces/newlines, etc.
      continue;
    }
    const key = a.slice(2);
    if (!key) throw new Error(`invalid flag '${a}' (empty flag name)`); // '--' / '-- value'
    const next = args[i + 1];
    // space form stays predictable: a `--`-prefixed token is ALWAYS a flag, never a value (so `--sql --db` is a
    // usage error, not sql="--db"). No flag value legitimately starts with `--` — sql can't (the SQL guard rejects
    // a leading `-- comment`), db/operation/run-id/resources don't — so require the `--key=value` form for the
    // exotic case instead of silently swallowing the next flag.
    if (next === undefined || next.startsWith("--")) throw new Error(`flag --${key} requires a value (use --${key}=<value> for a value starting with --)`);
    flags[key] = next;
    i++;
  }
  return flags;
}

function parseBindings(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("--bindings must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--bindings must be a JSON object");
  // each binding becomes a DuckDB session variable (SET VARIABLE <name> = ...), so the name must be a valid
  // identifier — reject at the CLI boundary (a usage error -> exit 2) rather than letting it throw deep in the runner.
  for (const k of Object.keys(parsed)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`--bindings key '${k}' must be a valid variable name ([A-Za-z_][A-Za-z0-9_]*)`);
  }
  return parsed as Record<string, unknown>;
}

const USAGE =
  "usage:\n" +
  "  pi-bio-agent query <manifest.json> --db <path|:memory:> --sql \"<SELECT/WITH/DESCRIBE/SUMMARIZE>\" [host options]\n" +
  "  pi-bio-agent run   <manifest.json> --db <path|:memory:> --operation <id> [host options]\n" +
  "  host options: [--network fetch [--max-response-bytes n]] [--compute local] [--cas-root dir] [--bindings '{...}'] [--protected-bindings-file json] [--protected-variables a,b] [--duckdb-config-file json] [--init-sql \"INSTALL ...; LOAD ...\"] [--ducknng-http-profile json] [--host-receipts-file json] [--remote-cache-scope scope] [--run-id id] [--ledger <path|auto> [--author name]]";

async function readJsonFile<T>(cwd: string, path: string, label: string): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    throw new Error(`${label} is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
}

/** Split a `;`-separated SQL string into statements WITHOUT splitting a `;` inside a single-quoted string literal
 *  (with `''` escapes). Enough for the provisioning escape hatch (`SET VARIABLE tls = fn('a;b')`); not a full
 *  SQL lexer (no dollar-quotes or block comments — provisioning SQL doesn't need them). */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "", inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inStr && sql[i + 1] === "'") { cur += "''"; i++; continue; } // doubled '' escape stays inside the string
      inStr = !inStr; cur += ch; continue;
    }
    if (ch === ";" && !inStr) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

type CliDucknngProfileSpec = Omit<DucknngHttpProfileSpec, "authHeaderValue"> & {
  authHeaderValueEnv?: string;
  authHeaderValueStdin?: boolean;
};

function stripOneTrailingNewline(value: string): string {
  return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function profileEntries(input: unknown): CliDucknngProfileSpec[] {
  const entries = Array.isArray(input) ? input : [input];
  if (entries.length === 0) throw new Error("profile file must contain one profile object or a non-empty array");
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`profile[${i}] must be an object`);
    const r = entry as Record<string, unknown>;
    if (r.authHeaderValue !== undefined) throw new Error(`profile[${i}] must not contain authHeaderValue; use authHeaderValueEnv or authHeaderValueStdin`);
    return r as unknown as CliDucknngProfileSpec;
  });
}

export async function loadDucknngHttpProfiles(path: string | undefined, deps: RunCliDeps): Promise<DucknngHttpProfileSpec[] | undefined> {
  if (path === undefined) return undefined;
  const text = await fs.readFile(resolve(deps.cwd, path), "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("--ducknng-http-profile must be valid JSON"); }
  const env = deps.env ?? process.env;
  let stdinSecret: string | undefined;
  const readStdinSecret = async (): Promise<string> => {
    if (stdinSecret !== undefined) return stdinSecret;
    if (!deps.readStdin) throw new Error("authHeaderValueStdin requires a CLI stdin reader");
    stdinSecret = stripOneTrailingNewline(await deps.readStdin());
    return stdinSecret;
  };
  const entries = profileEntries(parsed);
  if (entries.filter((entry) => entry.authHeaderValueStdin === true).length > 1) {
    throw new Error("at most one ducknng HTTP profile may read authHeaderValueStdin");
  }
  const out: DucknngHttpProfileSpec[] = [];
  for (const [i, entry] of entries.entries()) {
    const fromEnv = entry.authHeaderValueEnv;
    const fromStdin = entry.authHeaderValueStdin === true;
    if (fromEnv !== undefined && (typeof fromEnv !== "string" || fromEnv.length === 0)) throw new Error(`profile[${i}].authHeaderValueEnv must be a non-empty string`);
    if (fromEnv !== undefined && fromStdin) throw new Error(`profile[${i}] must choose only one of authHeaderValueEnv or authHeaderValueStdin`);
    if (fromEnv === undefined && !fromStdin) throw new Error(`profile[${i}] must declare authHeaderValueEnv or authHeaderValueStdin`);
    const authHeaderValue = fromEnv !== undefined ? env[fromEnv] : await readStdinSecret();
    if (typeof authHeaderValue !== "string" || authHeaderValue.length === 0) throw new Error(`profile[${i}] credential source is empty or unset`);
    const { authHeaderValueEnv: _env, authHeaderValueStdin: _stdin, ...profile } = entry;
    out.push({ ...(profile as Omit<DucknngHttpProfileSpec, "authHeaderValue">), authHeaderValue });
  }
  return out;
}

export async function mainRun(sub: string, argv: string[], deps: RunCliDeps): Promise<number> {
  const [manifestPath, ...rest] = argv;
  if (!manifestPath || manifestPath.startsWith("--")) { deps.err(USAGE); return 2; }
  // flag AND bindings parsing are both CLI-usage errors -> exit 2 with usage, never an unhandled throw
  let flags: Record<string, string>;
  let bindings: Record<string, unknown> | undefined;
  try {
    flags = parseFlags(rest);
    // PER-SUBCOMMAND flags, not a shared set: `run --resources` / `query --operation` would otherwise be accepted
    // and SILENTLY IGNORED (a `run` still resolves the operation's own requiredResources — the caller's --resources
    // exclusion is a no-op), which is exactly the surprising fall-through the unknown-flag hardening exists to stop.
    const COMMON = [
      "db", "bindings", "run-id", "init-sql", "ledger", "author", "remote-cache-scope", "ducknng-http-profile",
      "network", "max-response-bytes", "compute", "cas-root", "duckdb-config-file", "protected-bindings-file",
      "protected-variables", "host-receipts-file",
    ];
    const KNOWN = new Set(sub === "query" ? [...COMMON, "sql", "resources"] : [...COMMON, "operation"]);
    const unknown = Object.keys(flags).filter((k) => !KNOWN.has(k));
    if (unknown.length) throw new Error(`unknown flag(s) for '${sub}': ${unknown.map((k) => `--${k}`).join(", ")}`); // a typo / wrong-subcommand flag must not silently fall back
    const empty = Object.entries(flags).filter(([, v]) => v === "").map(([k]) => k);
    if (empty.length) throw new Error(`flag(s) with an empty value: ${empty.map((k) => `--${k}`).join(", ")}`); // `--db=` etc.
    if (flags.network && flags.network !== "fetch") throw new Error("--network currently accepts only 'fetch'");
    if (flags.compute && flags.compute !== "local") throw new Error("--compute currently accepts only 'local'");
    if (flags["max-response-bytes"] && flags.network !== "fetch") throw new Error("--max-response-bytes requires --network fetch");
    if (flags["max-response-bytes"] && (!Number.isSafeInteger(Number(flags["max-response-bytes"])) || Number(flags["max-response-bytes"]) < 1)) throw new Error("--max-response-bytes must be a positive safe integer");
    bindings = parseBindings(flags.bindings);
  } catch (e) { deps.err(e instanceof Error ? e.message : String(e)); deps.err(USAGE); return 2; }

  const dbPath = flags.db ?? ":memory:";
  const runId = flags["run-id"];
  // host provisioning (INSTALL/LOAD an extension, SET VARIABLE for a TLS config), run once before resolution —
  // `;`-separated statements. This is how a networked connector gets ducknng + TLS; it is NOT agent SQL.
  const initStmts = flags["init-sql"] ? splitSqlStatements(flags["init-sql"]) : [];
  const duckdbInitSql = initStmts.length ? initStmts : undefined;
  const remoteCacheScope = flags["remote-cache-scope"];
  if (sub === "query" && !flags.sql) { deps.err("query requires --sql <read-only result statement>"); deps.err(USAGE); return 2; }
  if (sub === "run" && !flags.operation) { deps.err("run requires --operation <operationId>"); deps.err(USAGE); return 2; }
  if (sub !== "query" && sub !== "run") { deps.err(USAGE); return 2; }
  let ducknngHttpProfiles: DucknngHttpProfileSpec[] | undefined;
  let duckdbConfig: Record<string, string> | undefined;
  let protectedSessionBindings: Record<string, unknown> | undefined;
  let hostCapabilityReceipts: HostCapabilityReceipt[] | undefined;
  try {
    ducknngHttpProfiles = await loadDucknngHttpProfiles(flags["ducknng-http-profile"], deps);
    if (flags["duckdb-config-file"]) {
      const value = await readJsonFile<unknown>(deps.cwd, flags["duckdb-config-file"], "--duckdb-config-file");
      assertObject(value, "--duckdb-config-file");
      if (Object.values(value).some((entry) => typeof entry !== "string")) throw new Error("--duckdb-config-file values must be strings");
      duckdbConfig = value as Record<string, string>;
    }
    if (flags["protected-bindings-file"]) {
      const value = await readJsonFile<unknown>(deps.cwd, flags["protected-bindings-file"], "--protected-bindings-file");
      assertObject(value, "--protected-bindings-file");
      protectedSessionBindings = value;
    }
    if (flags["host-receipts-file"]) {
      const value = await readJsonFile<unknown>(deps.cwd, flags["host-receipts-file"], "--host-receipts-file");
      if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error("--host-receipts-file must be a JSON array of receipt objects");
      hostCapabilityReceipts = value as HostCapabilityReceipt[];
    }
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const protectedSessionVariables = flags["protected-variables"]?.split(",").map((name) => name.trim()).filter(Boolean);
  const cas = flags["cas-root"] ? fsCasStore(resolve(deps.cwd, flags["cas-root"])) : undefined;
  const compute = flags.compute === "local" ? { runner: nodeComputeRunner() } : undefined;
  const network = flags.network === "fetch"
    ? { fetch: cappedFetchLike(globalThis.fetch, Number(flags["max-response-bytes"] ?? DEFAULT_MAX_RESPONSE_BYTES)) }
    : undefined;
  // Optional LEDGER opt-in: fold this run into the shared bio_observations store as a `run:<id>` fact — the thesis'
  // "compute status is a row in the one ledger" demonstrated from the provider-agnostic CLI, not just the extension.
  // EXPLICIT + path-specified (`--ledger <path|auto>`), never an ambient default (the CLI's visible-choice
  // discipline). FAIL CLOSED: DuckDB is a process-exclusive writer, so if another process (a live Pi session) holds
  // that store, openBioStore throws and we surface it here — we do NOT silently skip recording the run.
  let ledger: { conn: SqlConn; close: () => void } | undefined;
  if (flags.ledger) {
    try {
      ledger = await openBioStore(deps.cwd, flags.ledger === "auto" ? {} : { path: flags.ledger });
    } catch (e) {
      deps.err(`--ledger: could not open the observation store (${flags.ledger}): ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const common = {
    cwd: deps.cwd, dbPath, manifestPath, runId, bindings, duckdbInitSql, remoteCacheScope, ducknngHttpProfiles,
    network, compute, cas, signal: deps.signal, duckdbConfig, protectedSessionBindings, protectedSessionVariables, hostCapabilityReceipts,
    ...(ledger ? { store: ledger.conn, author: flags.author ?? "cli", ...(cas ? { casMetadata: { conn: ledger.conn } } : {}) } : {}),
  };

  let res;
  try {
    if (sub === "query") {
      const resources = flags.resources ? flags.resources.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      res = await runBioQueryFromManifest({ ...common, sql: flags.sql, resources });
    } else if (sub === "run") {
      res = await runBioOperationFromManifest({ ...common, operationId: flags.operation });
    } else {
      deps.err(USAGE);
      return 2;
    }
  } finally {
    ledger?.close();
  }

  if (!res.ok) {
    deps.err(`run ${res.runId} failed (${res.status}): ${res.error}`);
    deps.out(JSON.stringify({ ok: false, runId: res.runId, status: res.status, runDir: res.runDir }, null, 2));
    return 1;
  }
  // CLI runs always serialize their result view. A successful run with a missing/corrupt result file is evidence
  // corruption, not an empty answer, so let the error surface instead of silently printing `rows: undefined`.
  const rows = JSON.parse(await fs.readFile(join(res.runDir, "result.json"), "utf8")).rows;
  deps.out(JSON.stringify({ ok: true, runId: res.runId, status: res.status, rowCount: res.rowCount, artifacts: res.artifacts, runDir: res.runDir, rows }, null, 2));
  return 0;
}
