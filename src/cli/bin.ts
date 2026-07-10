#!/usr/bin/env node
import { mainMemory } from "./memory.js";
import { mainRun } from "./run.js";
import { installSkillUsage, mainInstallCodexSkill, mainInstallSkill } from "./install-skill.js";
import { mainCatalog } from "./catalog.js";
import { mainGraphWindow } from "./graph-window.js";
import { mainReproduce } from "./reproduce.js";
import { mainDescribe } from "./describe.js";
import { mainSession, SESSION_USAGE } from "./session.js";

/**
 * Thin process wrapper around the testable CLI engines. Each engine takes injected deps (out/err sinks) and
 * returns an exit code; this file is the only place that touches the real
 * DuckDB driver, process argv/cwd, stdout, and process.exit. Groups:
 *   catalog       — list manifest-backed sources/templates packaged with or supplied to the host
 *   describe      — validate one manifest and assess it against explicit CLI host capabilities
 *   query / run   — run a manifest's ad-hoc SQL or a declared operation (the substrate's value, provider-agnostic)
 *   graph-window  — page an existing DuckDB graph table (`bio_edges_as_of`, `entailed_edge`, external KG tables)
 *   session       — import persisted Pi/Codex JSONL into the temporal ledger and CAS
 *   memory        — read the temporal memory store (list / show / history, as-of)
 *   install-skill — install the packaged substrate skill into any host skill/playbook root
 *   install-codex-skill — compatibility alias for install-skill --host codex
 */
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(line);
const [group, ...rest] = process.argv.slice(2);
const abort = new AbortController();
process.once("SIGINT", () => abort.abort(new Error("interrupted by SIGINT")));
process.once("SIGTERM", () => abort.abort(new Error("interrupted by SIGTERM")));
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
};

const usage = (): string => [
  "usage: pi-bio-agent <catalog|describe|query|run|reproduce|graph-window|session|memory|install-skill|install-codex-skill> ...",
  "  catalog [--root <dir>] [--query <text>]",
  "  describe <manifest.json|url> [--network fetch] [--compute local] [--capabilities-file json]",
  "  query/run <manifest.json> --db <path> [--sql/--operation ...]",
  "  reproduce <replay.json> [--db :memory:] [--cas-root <dir>] [--compute local] [--ledger auto]",
  "  graph-window --db <path|:memory:> --start <node-id> [--table bio_edges] [--direction out|in|both] [--predicates p1,p2] [--limit n] [--offset n]",
  "  graph-window --db <path|:memory:> --continuation <graph-window:...>",
  `  ${SESSION_USAGE.replace(/\n/g, "\n  ")}`,
  "  memory <list|show|history> [slug] [--as-of <iso>]",
  "",
  installSkillUsage("install-skill"),
  "",
  installSkillUsage("install-codex-skill"),
].join("\n");

const dispatch = (): Promise<number> => {
  if (group === "--help" || group === "-h") {
    out(usage());
    return Promise.resolve(0);
  }
  if (group === "catalog") return mainCatalog(rest, { cwd: process.cwd(), out, err });
  if (group === "describe") return mainDescribe(rest, { cwd: process.cwd(), out, err, signal: abort.signal });
  if (group === "query" || group === "run") return mainRun(group, rest, { cwd: process.cwd(), out, err, env: process.env, readStdin, signal: abort.signal });
  if (group === "reproduce") return mainReproduce(rest, { cwd: process.cwd(), out, err, signal: abort.signal });
  if (group === "graph-window") return mainGraphWindow(rest, { cwd: process.cwd(), out, err });
  if (group === "session") return mainSession(rest, { cwd: process.cwd(), out, err });
  if (group === "memory") return mainMemory(rest, { cwd: process.cwd(), out, err });
  if (group === "install-skill") return mainInstallSkill(rest, { out, err });
  if (group === "install-codex-skill") return mainInstallCodexSkill(rest, { out, err });
  err(usage());
  return Promise.resolve(2);
};

dispatch().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
