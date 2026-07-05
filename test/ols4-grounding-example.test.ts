import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// SQL-native OLS4 grounding (metacurator disambiguate), DETERMINISTIC: a local ducknng server serves a canned
// OLS4-shaped response, and the manifest fetches it with `ducknng_ncurl_table` — the URL composed in SQL
// (getvariable + url_encode), NO TS resolver, no external network. The agent supplies the query as a binding
// (-> SET VARIABLE), points `ols4_base` at the local fixture, and grounds with one SQL line.
const MANIFEST = resolve(process.cwd(), "examples", "ols4-grounding", "manifest.json");
const PROVISION = ["INSTALL ducknng FROM community", "LOAD ducknng"];

const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

// Bind port 0 (OS-assigned) and DISCOVER the real base URL — a fixed port races under parallel test runs / TIME_WAIT.
async function startFixture(): Promise<{ base: string; close(): void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const fix = duckdbNodeConn(await inst.connect());
  await fix.run("LOAD ducknng");
  await fix.run(`SELECT ducknng_start_server('ols_fix', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
  const base = (await fix.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='ols_fix'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
  await fix.run(`SELECT ducknng_register_http_route('ols_fix', 'GET', '/search', 'SELECT * FROM ducknng_http_json(200, ''[{"obo_id":"MONDO:0004979","label":"asthma"},{"obo_id":"MONDO:0004784","label":"allergic asthma"}]'')')`);
  return { base, close: () => inst.closeSync() };
}

describe("example: OLS4 grounding is SQL all the way down (ducknng_ncurl)", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community on a matching DuckDB)" }, () => {
  test("local ducknng server -> ncurl_table fetch+parse -> SQL grounding, all SQL, no external network", async () => {
    const fixture = await startFixture();
    try {
      const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
      const out = await runBioQueryFromManifest({
        cwd, dbPath: ":memory:", manifestPath: MANIFEST,
        sql: "SELECT obo_id, label FROM ols4_candidates WHERE lower(label) = getvariable('query')",
        duckdbInitSql: PROVISION, duckdbConfig: { allow_unsigned_extensions: "true" },
        bindings: { ols4_base: fixture.base, query: "asthma" }, // agent supplies the query; base -> local fixture
        runId: "g1", now: "T1",
      });
      assert.equal(out.ok, true);
      if (!out.ok) return;
      const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ obo_id: string; label: string }> };
      assert.deepEqual(result.rows, [{ obo_id: "MONDO:0004979", label: "asthma" }]); // exact-match grounding over the fetched table
    } finally { fixture.close(); }
  });

  test("fails closed when {query} has no binding (url_encode(NULL) -> NULL url -> auditable failed run)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT 1",
      duckdbInitSql: PROVISION, duckdbConfig: { allow_unsigned_extensions: "true" },
      bindings: { ols4_base: "http://127.0.0.1:45581" }, // no query -> the composed URL is NULL; no server needed
      runId: "g2", now: "T1",
    });
    assert.equal(out.ok, false);
  });
});
