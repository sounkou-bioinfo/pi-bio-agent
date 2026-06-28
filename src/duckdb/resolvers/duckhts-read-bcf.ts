import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BioResolverImpl } from "../../core/manifest.js";

// Generic DuckHTS reader: materialize an HTS file (VCF/BCF) into a RAW table via read_bcf(tidy_format) and
// nothing more — the parallel of duckdb.file_scan, for HTS formats. There is deliberately NO source-specific
// column mapping here (INFO_MC -> consequence, etc.): that is BIO LOGIC and belongs in the operation's SQL,
// as manifest data, not in this adapter. A new annotated-VCF dialect is a new SQL projection, never a new .ts.
//
// no INSTALL and no hidden/ambient network: this LOADs an already-provisioned extension (failing closed if
// absent) and reads exactly the path/URI the resource declares. That path MAY be remote (htslib reads
// http(s)/s3) — but a remote URI is explicit in the manifest and recorded in the receipt, never a surprise fetch.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const duckhtsReadBcfResolver: BioResolverImpl = async (resource, ctx) => {
  const { path, table = "vcf_raw" } = resource.params as { path: string; table?: string };
  if (typeof path !== "string" || !path.trim()) throw new Error("duckhts.read_bcf: 'path' (string) is required");
  if (!IDENT_RE.test(table)) throw new Error("duckhts.read_bcf: 'table' must be a SQL identifier");
  const now = ctx.now ?? new Date().toISOString();

  // Fail closed if duckhts is not loadable. No INSTALL here — the host must provision the extension.
  try {
    await ctx.conn.run("LOAD duckhts;");
  } catch (e) {
    throw new Error(`duckhts.read_bcf: the duckhts extension is not loadable on this connection (the host must INSTALL it first): ${(e as Error).message}`);
  }

  let duckhtsVersion: string | undefined;
  try {
    const rows = await ctx.conn.all<{ extension_version: string }>("SELECT extension_version FROM duckdb_extensions() WHERE extension_name = 'duckhts'");
    duckhtsVersion = rows[0]?.extension_version ?? undefined;
  } catch {
    /* version is best-effort provenance */
  }

  // Pin the exact input by content digest when the path is a readable local file (best effort).
  let inputDigest: string | undefined;
  try {
    inputDigest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    /* non-local or unreadable path: read_bcf fails closed below if the input is truly missing */
  }

  // Raw read only: SELECT * preserves the tidy columns (CHROM, POS, REF, ALT, INFO_*). Mapping is the
  // operation's job, in SQL.
  await ctx.conn.run(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_bcf(?, tidy_format := true)`, [path]);

  const sourceUri = path.includes("://") ? path : `file:${path}`; // a remote input is its own URI, not file:
  return {
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [
      { source: "duckhts", version: duckhtsVersion, retrievedAt: now },
      { source: sourceUri, version: inputDigest, retrievedAt: now },
    ],
    provenance: [{ source: "duckhts.read_bcf", retrievedAt: now }],
  };
};
