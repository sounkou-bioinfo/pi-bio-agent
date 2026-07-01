#!/usr/bin/env node
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { mainNotes } from "./notes.js";
import { mainRun } from "./run.js";

/**
 * Thin process wrapper around the testable CLI engines. Each engine takes injected deps (out/err sinks, and for
 * `notes` a connection-factory) and returns an exit code; this file is the only place that touches the real
 * DuckDB driver, process argv/cwd, stdout, and process.exit. Groups:
 *   query / run   — run a manifest's ad-hoc SQL or a declared operation (the substrate's value, provider-agnostic)
 *   notes         — study-note sync / report
 */
const out = (line: string) => console.log(line);
const err = (line: string) => console.error(line);
const [group, ...rest] = process.argv.slice(2);

const dispatch = (): Promise<number> => {
  if (group === "query" || group === "run") return mainRun(group, rest, { cwd: process.cwd(), out, err });
  if (group === "notes") {
    return mainNotes(rest, {
      cwd: process.cwd(),
      openConn: async (db) => duckdbNodeConn(await (await DuckDBInstance.create(db)).connect()),
      out, err,
    });
  }
  err("usage: pi-bio-agent <query|run|notes> ...\n  query/run <manifest.json> --db <path> [--sql/--operation ...]\n  notes <sync|report> --db <path> [...]");
  return Promise.resolve(2);
};

dispatch().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
