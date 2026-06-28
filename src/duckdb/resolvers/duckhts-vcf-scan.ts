import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BioResolverImpl } from "../../core/manifest.js";

// First REAL resolver: read an annotated VCF/BCF into a stable `annotated_variants`-shaped table via the
// duckhts community extension. An adapter, not core — it executes DDL and assumes the duckhts surface.
//
// Rules (deliberate): no bespoke VCF parser fallback; no INSTALL and no hidden/ambient network. This LOADs
// an already-provisioned extension (failing closed if absent) and reads exactly the path/URI the resource
// declares. That path MAY be remote — duckhts/htslib can read http(s)/s3 — but a remote URI is explicit in
// the manifest and recorded in the receipt, never a surprise fetch. The 163 VCF-parsing reimplementations in
// ClawBio collapse to this one resolver behind the BioResolverImpl contract.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Fixed mapping from a VEP/ClinVar-style annotated VCF's INFO fields to the stable downstream columns.
// Generalize to configurable INFO fields only when a second VCF shape needs it.
const EXTRACT_SQL = (table: string) => `CREATE OR REPLACE TABLE ${table} AS
  SELECT CHROM || ':' || POS || ':' || REF || ':' || ALT[1] AS variant_key,
         INFO_MC[1]     AS consequence,
         INFO_AF[1]     AS allele_frequency,
         INFO_CLNSIG[1] AS clinical_significance
  FROM read_bcf(?, tidy_format := true)`;

export const duckhtsVcfScanResolver: BioResolverImpl = async (resource, ctx) => {
  const { path, table = "annotated_variants" } = resource.params as { path: string; table?: string };
  if (typeof path !== "string" || !path.trim()) throw new Error("duckhts.vcf_scan: 'path' (string) is required");
  if (!IDENT_RE.test(table)) throw new Error("duckhts.vcf_scan: 'table' must be a SQL identifier");
  const now = ctx.now ?? new Date().toISOString();

  // Fail closed if duckhts is not loadable. No INSTALL here — the host must provision the extension.
  try {
    await ctx.conn.run("LOAD duckhts;");
  } catch (e) {
    throw new Error(`duckhts.vcf_scan: the duckhts extension is not loadable on this connection (the host must INSTALL it first): ${(e as Error).message}`);
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

  await ctx.conn.run(EXTRACT_SQL(table), [path]);

  return {
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" } },
    sourceSnapshots: [
      { source: "duckhts", version: duckhtsVersion, retrievedAt: now },
      { source: `file:${path}`, version: inputDigest, retrievedAt: now },
    ],
    provenance: [{ source: "duckhts.vcf_scan", retrievedAt: now }],
  };
};
