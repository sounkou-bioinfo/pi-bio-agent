import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runBioOperationFromManifest, runBioQueryFromManifest } from "../hosts/run-store.js";

// The `query` / `run` CLI engine — the substrate's actual value at a provider-agnostic entry point (not Pi-only).
// It wraps the SAME tested host functions the Pi extension uses (runBioQueryFromManifest / runBioOperationFromManifest),
// so the CLI and the agent share one code path. Deliberately FAIL-CLOSED like the default Pi entrypoint: no network,
// no out-of-process compute are bound here, so a networked/compute manifest fails closed. (A networked CLI variant
// can compose a fetch in later, the visible-choice discipline — never an ambient default.)
//
//   pi-bio-agent query <manifest.json> --db <path|:memory:> --sql "<read-only SELECT>" [--resources a,b] [--run-id id]
//   pi-bio-agent run   <manifest.json> --db <path|:memory:> --operation <operationId>   [--run-id id]
//
// On success it prints the run response (runId/status/rowCount/runDir/artifacts) AND the result rows (result.json)
// as JSON; on a failed run it prints the error and returns exit code 1. Bindings pass agent params as session vars.

export interface RunCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
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
    if (next === undefined) throw new Error(`flag --${key} requires a value`);
    flags[key] = next; // consume the next token AS the value (all flags take values), even if it looks like a flag
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
  "  pi-bio-agent query <manifest.json> --db <path|:memory:> --sql \"<SELECT>\" [--resources a,b] [--bindings '{...}'] [--run-id id]\n" +
  "  pi-bio-agent run   <manifest.json> --db <path|:memory:> --operation <id> [--bindings '{...}'] [--run-id id]";

export async function mainRun(sub: string, argv: string[], deps: RunCliDeps): Promise<number> {
  const [manifestPath, ...rest] = argv;
  if (!manifestPath || manifestPath.startsWith("--")) { deps.err(USAGE); return 2; }
  // flag AND bindings parsing are both CLI-usage errors -> exit 2 with usage, never an unhandled throw
  let flags: Record<string, string>;
  let bindings: Record<string, unknown> | undefined;
  try {
    flags = parseFlags(rest);
    const KNOWN = new Set(["db", "sql", "resources", "operation", "bindings", "run-id"]);
    const unknown = Object.keys(flags).filter((k) => !KNOWN.has(k));
    if (unknown.length) throw new Error(`unknown flag(s): ${unknown.map((k) => `--${k}`).join(", ")}`); // a typo must not silently fall back
    bindings = parseBindings(flags.bindings);
  } catch (e) { deps.err(e instanceof Error ? e.message : String(e)); deps.err(USAGE); return 2; }

  const dbPath = flags.db ?? ":memory:";
  const runId = flags["run-id"];
  const common = { cwd: deps.cwd, dbPath, manifestPath, runId, bindings };

  let res;
  if (sub === "query") {
    if (!flags.sql) { deps.err("query requires --sql <read-only SELECT>"); deps.err(USAGE); return 2; }
    const resources = flags.resources ? flags.resources.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    res = await runBioQueryFromManifest({ ...common, sql: flags.sql, resources });
  } else if (sub === "run") {
    if (!flags.operation) { deps.err("run requires --operation <operationId>"); deps.err(USAGE); return 2; }
    res = await runBioOperationFromManifest({ ...common, operationId: flags.operation });
  } else {
    deps.err(USAGE);
    return 2;
  }

  if (!res.ok) {
    deps.err(`run ${res.runId} failed (${res.status}): ${res.error}`);
    deps.out(JSON.stringify({ ok: false, runId: res.runId, status: res.status, runDir: res.runDir }, null, 2));
    return 1;
  }
  // success: emit the response summary + the actual answer rows (result.json under the run dir)
  let rows: unknown = undefined;
  try { rows = JSON.parse(await fs.readFile(join(res.runDir, "result.json"), "utf8")).rows; } catch { /* files-only / no rows */ }
  deps.out(JSON.stringify({ ok: true, runId: res.runId, status: res.status, rowCount: res.rowCount, artifacts: res.artifacts, runDir: res.runDir, rows }, null, 2));
  return 0;
}
