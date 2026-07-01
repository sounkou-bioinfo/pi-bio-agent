import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BioManifest } from "../src/core/manifest.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// The runner connection-init hook (pal #8's gap): a host bootstraps the DuckDB connection ONCE before
// resolution — the place to INSTALL/LOAD/SET httpfs + cache_httpfs (so file_scan/sql_materialize remote reads
// get block caching), set an extension dir, etc. It is HOST-owned config, composed in like network/cas; the
// agent never supplies it. Offline test: init creates a table the query then reads, proving init ran first.

// a resource-free manifest: the query runs over whatever init set up on the connection
const manifest: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "init-sql-host",
  version: "0.1.0",
  title: "Init SQL (host)",
  description: "No resources; the host bootstraps the connection and the query reads what it set up.",
  provides: {},
};

async function writeManifest(): Promise<{ cwd: string; manifestPath: string }> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-init-"));
  const manifestPath = join(cwd, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  return { cwd, manifestPath };
}

describe("run-store connection-init hook (duckdbInitSql)", () => {
  test("init SQL runs once on the connection BEFORE the query, so the query sees what it created", async () => {
    const { cwd, manifestPath } = await writeManifest();
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath,
      duckdbInitSql: ["CREATE TABLE init_marker AS SELECT 7 AS x", "INSERT INTO init_marker VALUES (35)"],
      sql: "SELECT sum(x) AS total FROM init_marker",
      runId: "i1", now: "T1",
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ total: number | bigint }> };
    assert.equal(Number(result.rows[0]!.total), 42, "the query read the table the init SQL created (7 + 35)");
  });

  test("a failing init statement is a pre-flight config error (throws), not a failed run", async () => {
    const { cwd, manifestPath } = await writeManifest();
    // a bogus init statement must surface as a thrown config error — the run never started, so it is not ok:false
    await assert.rejects(
      () => runBioQueryFromManifest({
        cwd, dbPath: ":memory:", manifestPath,
        duckdbInitSql: ["SELECT * FROM a_table_that_does_not_exist_for_init"],
        sql: "SELECT 1 AS x", runId: "i2", now: "T1",
      }),
      /a_table_that_does_not_exist_for_init|Catalog|does not exist/,
    );
  });

  test("no init SQL — unchanged behavior", async () => {
    const { cwd, manifestPath } = await writeManifest();
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath, sql: "SELECT 1 AS x", runId: "i3", now: "T1" });
    assert.equal(out.ok, true);
  });
});
