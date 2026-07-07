#!/usr/bin/env node
import { mainMemory } from "./memory.js";
import { mainRun } from "./run.js";
import { mainInstallCodexSkill, mainInstallSkill } from "./install-skill.js";

/**
 * Thin process wrapper around the testable CLI engines. Each engine takes injected deps (out/err sinks) and
 * returns an exit code; this file is the only place that touches the real
 * DuckDB driver, process argv/cwd, stdout, and process.exit. Groups:
 *   query / run   — run a manifest's ad-hoc SQL or a declared operation (the substrate's value, provider-agnostic)
 *   memory        — read the temporal memory store (list / show / history, as-of)
 *   install-skill — install the packaged substrate skill into any host skill/playbook root
 *   install-codex-skill — compatibility alias for install-skill --host codex
 */
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(line);
const [group, ...rest] = process.argv.slice(2);

const dispatch = (): Promise<number> => {
  if (group === "query" || group === "run") return mainRun(group, rest, { cwd: process.cwd(), out, err });
  if (group === "memory") return mainMemory(rest, { cwd: process.cwd(), out, err });
  if (group === "install-skill") return mainInstallSkill(rest, { out, err });
  if (group === "install-codex-skill") return mainInstallCodexSkill(rest, { out, err });
  err("usage: pi-bio-agent <query|run|memory|install-skill|install-codex-skill> ...\n  query/run <manifest.json> --db <path> [--sql/--operation ...]\n  memory <list|show|history> [slug] [--as-of <iso>]\n  install-skill [--host <preset>|--dest <host-skills-dir>] [--force]\n  install-codex-skill [--force] [--dest <dir>]");
  return Promise.resolve(2);
};

dispatch().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
