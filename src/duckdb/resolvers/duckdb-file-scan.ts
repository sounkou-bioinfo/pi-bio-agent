import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BioResolverImpl } from "../../core/manifest.js";

// Generic DuckDB-native file resolver. A *variant record* (or any record) is an abstraction over a table
// shape — the source FORMAT is a swappable provider. VCF/BCF is one provider (duckhts.vcf_scan); CSV, TSV,
// Parquet, and JSON are native to DuckDB and need no extension; 23andMe/MAF/Excel are just more readers.
// This resolver materializes any DuckDB-readable file into a table; the same downstream operation consumes
// it regardless of where the rows came from.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Native DuckDB table functions only (no extension required). Add xlsx/excel here once that extension is
// provisioned by the host, the same way duckhts handles HTS formats.
const READERS: Record<string, string> = {
  csv: "read_csv_auto",
  tsv: "read_csv_auto",
  txt: "read_csv_auto",
  parquet: "read_parquet",
  json: "read_json_auto",
};

function readerFor(path: string, explicit?: string): string {
  if (explicit) {
    const fn = READERS[explicit];
    if (!fn) throw new Error(`duckdb.file_scan: unknown reader '${explicit}' (expected one of ${Object.keys(READERS).join(", ")})`);
    return fn;
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const fn = READERS[ext];
  if (!fn) throw new Error(`duckdb.file_scan: cannot infer a reader from '.${ext}'; pass reader explicitly (${Object.keys(READERS).join("|")})`);
  return fn;
}

export const duckdbFileScanResolver: BioResolverImpl = async (resource, ctx) => {
  const { path, reader, table = "data" } = resource.params as { path: string; reader?: string; table?: string };
  if (typeof path !== "string" || !path.trim()) throw new Error("duckdb.file_scan: 'path' (string) is required");
  if (!IDENT_RE.test(table)) throw new Error("duckdb.file_scan: 'table' must be a SQL identifier");
  const fn = readerFor(path, reader);
  const now = ctx.now ?? new Date().toISOString();

  let inputDigest: string | undefined;
  try {
    inputDigest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    /* non-local or unreadable path: the reader fails closed below if the input is truly missing */
  }

  await ctx.conn.run(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${fn}(?)`, [path]);

  const sourceUri = path.includes("://") ? path : `file:${path}`; // a remote input is its own URI, not file:
  return {
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [
      { source: sourceUri, version: inputDigest, retrievedAt: now },
      { source: `duckdb.${fn}`, retrievedAt: now },
    ],
    provenance: [{ source: "duckdb.file_scan", retrievedAt: now }],
  };
};
