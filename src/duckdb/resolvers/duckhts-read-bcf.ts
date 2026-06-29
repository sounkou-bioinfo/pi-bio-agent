import { createHash } from "node:crypto";
import { systemClock } from "../../core/clock.js";
import { readFileSync } from "node:fs";
import type { BioResolverImpl } from "../../core/ports.js";

// Generic DuckHTS reader: materialize an HTS file (VCF/BCF) into a RAW table via read_bcf(tidy_format) and
// nothing more — the parallel of duckdb.file_scan, for HTS formats. There is deliberately NO source-specific
// column mapping here (INFO_MC -> consequence, etc.): that is BIO LOGIC and belongs in the operation's SQL,
// as manifest data, not in this adapter. A new annotated-VCF dialect is a new SQL projection, never a new .ts.
//
// no INSTALL and no hidden/ambient network: this LOADs an already-provisioned extension (failing closed if
// absent) and reads exactly the path/URI the resource declares. That path MAY be remote (htslib reads
// http(s)/s3) — but a remote URI is explicit in the manifest and recorded in the receipt, never a surprise fetch.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Normalize a region to an htslib region string. htslib regions are 1-based, closed intervals — the manifest
// author supplies coordinates in that convention (BED's 0-based half-open must be converted by the author).
function regionString(region: unknown): string | undefined {
  if (region === undefined || region === null) return undefined;
  if (typeof region === "string") return region.trim() || undefined;
  if (typeof region === "object") {
    const { chrom, start, end } = region as { chrom?: unknown; start?: unknown; end?: unknown };
    if (typeof chrom === "string" && chrom.trim() && Number.isInteger(start) && Number.isInteger(end)) return `${chrom}:${start}-${end}`;
  }
  throw new Error("duckhts.read_bcf: 'region' must be an htslib 'chrom:start-end' string or { chrom, start, end }");
}

export const duckhtsReadBcfResolver: BioResolverImpl = async (resource, ctx) => {
  const { path, table = "vcf_raw" } = resource.params as { path: string; table?: string };
  if (typeof path !== "string" || !path.trim()) throw new Error("duckhts.read_bcf: 'path' (string) is required");
  if (!IDENT_RE.test(table)) throw new Error("duckhts.read_bcf: 'table' must be a SQL identifier");
  const region = regionString((resource.params as { region?: unknown }).region);
  const now = ctx.now ?? systemClock();

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

  // Provenance honesty for region reads (pal #7): a whole-file digest is MISLEADING when only a region's blocks
  // were read (and impossible for a huge remote VCF that was never downloaded). For a REGION read, pin the small
  // companion INDEX (.tbi/.csi) by digest + record the region; for a whole-file read, digest the file itself.
  let inputDigest: string | undefined;
  if (region) {
    for (const ext of [".tbi", ".csi"]) {
      try { inputDigest = `index-sha256:${createHash("sha256").update(readFileSync(path + ext)).digest("hex")}`; break; } catch { /* try next / best effort */ }
    }
  } else {
    try { inputDigest = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`; } catch { /* non-local/unreadable: read_bcf fails closed below */ }
  }

  // Raw read only: SELECT * preserves the tidy columns (CHROM, POS, REF, ALT, INFO_*). Mapping is the
  // operation's job, in SQL. With a region, htslib reads ONLY that region's blocks via the index (the gnomAD/
  // coloc small-region path) — no whole-file scan.
  const sql = region
    ? `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_bcf(?, region := ?, tidy_format := true)`
    : `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_bcf(?, tidy_format := true)`;
  await ctx.conn.run(sql, region ? [path, region] : [path]);

  const sourceUri = path.includes("://") ? path : `file:${path}`; // a remote input is its own URI, not file:
  return {
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [
      { source: "duckhts", version: duckhtsVersion, retrievedAt: now },
      { source: sourceUri, version: inputDigest, retrievedAt: now },
    ],
    // record the region in provenance so a region read is auditable as exactly the slice it read, not the whole file
    provenance: [{ source: "duckhts.read_bcf", retrievedAt: now, notes: region ? ["region read", `region:${region}`] : ["whole-file read"] }],
  };
};
