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

/** Parse `--key value` / `--flag` pairs after the positional manifest path. Repeated keys keep the last. */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}' (expected --key value)`);
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`flag --${key} requires a value`);
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
  return parsed as Record<string, unknown>;
}

const USAGE =
  "usage:\n" +
  "  pi-bio-agent query <manifest.json> --db <path|:memory:> --sql \"<SELECT>\" [--resources a,b] [--bindings '{...}'] [--run-id id]\n" +
  "  pi-bio-agent run   <manifest.json> --db <path|:memory:> --operation <id> [--bindings '{...}'] [--run-id id]";

export async function mainRun(sub: string, argv: string[], deps: RunCliDeps): Promise<number> {
  const [manifestPath, ...rest] = argv;
  if (!manifestPath || manifestPath.startsWith("--")) { deps.err(USAGE); return 2; }
  let flags: Record<string, string>;
  try { flags = parseFlags(rest); } catch (e) { deps.err(e instanceof Error ? e.message : String(e)); deps.err(USAGE); return 2; }

  const dbPath = flags.db ?? ":memory:";
  const runId = flags["run-id"];
  const bindings = parseBindings(flags.bindings);
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
