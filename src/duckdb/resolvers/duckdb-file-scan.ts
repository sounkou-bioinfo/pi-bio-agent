import { createHash } from "node:crypto";
import { systemClock } from "../../core/clock.js";
import { readFileSync } from "node:fs";
import type { BioResolverImpl, ResolverOutput } from "../../core/ports.js";
import { memoLookup, memoStore } from "../resolution-memo.js";

// Generic DuckDB-native file resolver. A *variant record* (or any record) is an abstraction over a table
// shape — the source FORMAT is a swappable provider. VCF/BCF is one provider (duckhts.read_bcf); CSV, TSV,
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
  const now = ctx.now ?? systemClock();

  // Memoization key = the file's CONTENT digest (not mtime+size, which false-hits on a same-size change with a
  // preserved/coarse mtime). Computing it re-reads the file, but a hit still skips the DuckDB load (the parse,
  // the expensive part for csv/json/text). The token captures every determinant — resolver + reader + path +
  // content — so a different recipe to the same table name can never false-hit. Remote/unreadable paths yield
  // no digest -> no memo (always re-resolve), the safe default; the reader fails closed below if truly missing.
  let inputDigest: string | undefined;
  try {
    inputDigest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    /* non-local or unreadable path -> no content digest, no memo */
  }
  const freshness = inputDigest === undefined ? undefined : `file_scan:${fn}:${path}:${inputDigest}`;
  if (freshness !== undefined) {
    const hit = await memoLookup(ctx.conn, table, freshness);
    if (hit) return hit; // identical content + table present: replay the receipt, skip the DuckDB load
  }

  await ctx.conn.run(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${fn}(?)`, [path]);

  // TOCTOU: the digest was computed BEFORE the scan, so a file changed between hash and scan would falsely pin the
  // OLD content while the table holds the NEW data — an unsafe reproduce "match" / ActionCache key. Re-hash AFTER the
  // scan: if the content is unchanged, the pin is verifiably valid; if it changed (or the file became unreadable),
  // DROP the pin (undefined -> live_source, no memo) so a hit can never serve stale.
  if (inputDigest !== undefined) {
    let afterDigest: string | undefined;
    try { afterDigest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; } catch { afterDigest = undefined; }
    if (afterDigest !== inputDigest) inputDigest = undefined;
  }

  const sourceUri = path.includes("://") ? path : `file:${path}`; // a remote input is its own URI, not file:
  const output: ResolverOutput = {
    result: { mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [
      { source: sourceUri, version: inputDigest, retrievedAt: now },
      { source: `duckdb.${fn}`, retrievedAt: now },
    ],
    // live_source ONLY when we could NOT content-digest the file (remote/unreadable path -> no version above): then
    // the receipt isn't content-pinned, so reproduce must not claim a match without a CAS output pin. A local file
    // WITH a content digest is fully reproducible (a changed file is honest drift) — no marker.
    provenance: [{ source: "duckdb.file_scan", retrievedAt: now, ...(inputDigest === undefined ? { notes: ["live_source"] } : {}) }],
  };
  // Only memoize when the content pin held across the scan (inputDigest still set) — a file that changed mid-scan is
  // live, not stably keyable. (freshness embeds the pre-scan digest, which equals the post-scan one when unchanged.)
  if (freshness !== undefined && inputDigest !== undefined) await memoStore(ctx.conn, table, freshness, output);
  return output;
};
