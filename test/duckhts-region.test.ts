import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckhtsReadBcfResolver } from "../src/duckdb/resolvers/duckhts-read-bcf.js";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";

// Baseline item 3: region-scoped read_bcf — the gnomAD/coloc data tier. htslib reads ONLY the region's blocks
// via the tabix index (no whole-file scan), and the receipt records the region + digests the small index, not a
// misleading whole-file digest (pal #7). Fixture: a bgzipped + tabix-indexed VCF with one variant per chrom 1-5.
const VCF_GZ = "test/fixtures/rare_high_impact.vcf.gz";
const duckhtsAvailable = await (async () => {
  try { await (await (await DuckDBInstance.create(":memory:")).connect()).run("LOAD duckhts;"); return true; } catch { return false; }
})();
const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "duckhts.read_bcf", params });
async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("duckhts.read_bcf region read (tabix range — the gnomAD/coloc tier)", { skip: duckhtsAvailable ? false : "duckhts unavailable (offline)" }, () => {
  test("a region reads only that locus's variants + records the region in provenance (not a whole-file digest)", async () => {
    const conn = await memoryConn();
    const out = await duckhtsReadBcfResolver(resource({ path: VCF_GZ, table: "vcf_raw", region: "2:1500-2500" }), { conn, now: "T1" });
    const rows = await conn.all<{ CHROM: string; POS: number | bigint }>("SELECT CHROM, POS FROM vcf_raw");
    assert.equal(rows.length, 1, "only the chrom-2 variant is in the region");
    assert.equal(String(rows[0]!.CHROM), "2");
    assert.equal(Number(rows[0]!.POS), 2000);
    // a region read pins only index-digest + data size/mtime (NOT the region's bytes), so it is marked live_source:
    // reproduce/action-cache treat it as not content-verified — honest, since a changed BGZF slice can keep size/mtime.
    assert.deepEqual(out.provenance[0]!.notes, ["region read", "region:2:1500-2500", "live_source"]);
    assert.match(out.sourceSnapshots[1]!.version ?? "", /^index-sha256:/); // digests the .tbi, not the whole VCF
  });

  test("a structured { chrom, start, end } region works too", async () => {
    const conn = await memoryConn();
    await duckhtsReadBcfResolver(resource({ path: VCF_GZ, table: "vcf_raw", region: { chrom: "4", start: 3500, end: 4500 } }), { conn, now: "T1" });
    const rows = await conn.all<{ POS: number | bigint }>("SELECT POS FROM vcf_raw ORDER BY POS");
    assert.deepEqual(rows.map((r) => Number(r.POS)), [4000]);
  });

  test("no region still does a whole-file read (digests the file)", async () => {
    const conn = await memoryConn();
    const out = await duckhtsReadBcfResolver(resource({ path: VCF_GZ, table: "vcf_raw" }), { conn, now: "T1" });
    const n = await conn.all<{ n: number | bigint }>("SELECT count(*) AS n FROM vcf_raw");
    assert.equal(Number(n[0]!.n), 5);
    assert.deepEqual(out.provenance[0]!.notes, ["whole-file read"]);
    assert.match(out.sourceSnapshots[1]!.version ?? "", /^sha256:/);
  });
});
