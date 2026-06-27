#!/usr/bin/env node
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../duckdb/node-api.js";
import { mainNotes } from "./notes.js";

/**
 * Thin process wrapper around the testable CLI engine. The engine (`mainNotes`) takes an injected
 * connection-factory and output sink and returns an exit code; this file is the only place that touches
 * the real DuckDB driver, process argv/cwd, stdout, and process.exit.
 */
const [group, ...rest] = process.argv.slice(2);
if (group !== "notes") {
  console.error("usage: pi-bio-agent notes <sync|report> --db <path> [...]");
  process.exit(2);
}

mainNotes(rest, {
  cwd: process.cwd(),
  openConn: async (db) => duckdbNodeConn(await (await DuckDBInstance.create(db)).connect()),
  out: (line) => console.log(line),
}).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
