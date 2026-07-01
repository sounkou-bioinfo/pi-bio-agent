#!/usr/bin/env node
import { mainMemory } from "./memory.js";
import { mainRun } from "./run.js";

/**
 * Thin process wrapper around the testable CLI engines. Each engine takes injected deps (out/err sinks, and for
 * `notes` a connection-factory) and returns an exit code; this file is the only place that touches the real
 * DuckDB driver, process argv/cwd, stdout, and process.exit. Groups:
 *   query / run   — run a manifest's ad-hoc SQL or a declared operation (the substrate's value, provider-agnostic)
 *   memory        — read the temporal memory store (list / show / history, as-of)
 */
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(line);
const [group, ...rest] = process.argv.slice(2);

const dispatch = (): Promise<number> => {
  if (group === "query" || group === "run") return mainRun(group, rest, { cwd: process.cwd(), out, err });
  if (group === "memory") return mainMemory(rest, { cwd: process.cwd(), out, err });
  err("usage: pi-bio-agent <query|run|memory> ...\n  query/run <manifest.json> --db <path> [--sql/--operation ...]\n  memory <list|show|history> [slug] [--as-of <iso>]");
  return Promise.resolve(2);
};

dispatch().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
