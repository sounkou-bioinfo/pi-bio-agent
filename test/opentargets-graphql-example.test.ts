import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { runBioOperationFromManifest } from "../src/hosts/run-store.js";

const MANIFEST = resolve(process.cwd(), "examples", "connectors", "opentargets-graphql.json");
const OPENTARGETS_SOURCE = "https://api.platform.opentargets.org/api/v4/graphql";
const PROVISION = ["LOAD ducknng"];

const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch {
    return false;
  }
})();

const GRAPHQL_BODY = {
  data: {
    target: {
      id: "ENSG00000157764",
      approvedSymbol: "BRAF",
      associatedDiseases: {
        count: 3139,
        rows: [
          { score: 0.8769922233616118, disease: { id: "MONDO_0015280", name: "cardiofaciocutaneous syndrome" } },
          { score: 0.8380641899091844, disease: { id: "MONDO_0018997", name: "Noonan syndrome" } },
        ],
      },
    },
  },
};

async function startFixture(): Promise<{ url: string; close(): void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const fix = duckdbNodeConn(await inst.connect());
  await fix.run("LOAD ducknng");
  await fix.run("SELECT ducknng_start_server('opentargets_fix', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)");
  const base = (await fix.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='opentargets_fix'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
  const canned = JSON.stringify(GRAPHQL_BODY).replaceAll("'", "''");
  await fix.run(
    "SELECT ducknng_register_http_route('opentargets_fix', 'POST', '/api/v4/graphql', " +
      "'SELECT * FROM ducknng_http_json(" +
      "  CASE WHEN json_valid((SELECT body_text FROM ducknng_http_request_body())) " +
      "       AND json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.variables.ensemblId'') = ''ENSG00000157764'' " +
      "       AND try_cast(json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.variables.pageSize'') AS INTEGER) = 2 " +
      "       THEN 200 ELSE 400 END, " +
      `  ''${canned}'')')`,
  );
  return { url: `${base}/api/v4/graphql`, close: () => inst.closeSync() };
}

async function manifestWithSource(cwd: string, source: string): Promise<string> {
  const raw = await fs.readFile(MANIFEST, "utf8");
  assert.ok(raw.includes(OPENTARGETS_SOURCE), "fixture manifest patch must track the example source URL");
  const path = join(cwd, "manifest.json");
  await fs.writeFile(path, raw.split(OPENTARGETS_SOURCE).join(source));
  return path;
}

describe("example: OpenTargets GraphQL as a SQL-native connector", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  test("POSTs a GraphQL body through ducknng_ncurl_table and unnests the typed response", async () => {
    const fixture = await startFixture();
    try {
      const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-opentargets-"));
      const manifestPath = await manifestWithSource(cwd, fixture.url);
      const out = await runBioOperationFromManifest({
        cwd,
        dbPath: ":memory:",
        manifestPath,
        operationId: "opentargets.associated_diseases",
        duckdbInitSql: PROVISION,
        duckdbConfig: { allow_unsigned_extensions: "true" },
        bindings: { ensembl_id: "ENSG00000157764", page_size: 2 },
        runId: "opentargets-fixture",
        now: "2026-07-06T12:30:00.000Z",
      });
      assert.equal(out.ok, true, out.ok ? undefined : out.error);
      if (!out.ok) return;

      const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as {
        rows: Array<{ target_id: string; approved_symbol: string; total_count: number; disease_id: string; disease_name: string; score: number }>;
      };
      assert.deepEqual(result.rows, [
        {
          target_id: "ENSG00000157764",
          approved_symbol: "BRAF",
          total_count: 3139,
          disease_id: "MONDO_0015280",
          disease_name: "cardiofaciocutaneous syndrome",
          score: 0.8769922233616118,
        },
        {
          target_id: "ENSG00000157764",
          approved_symbol: "BRAF",
          total_count: 3139,
          disease_id: "MONDO_0018997",
          disease_name: "Noonan syndrome",
          score: 0.8380641899091844,
        },
      ]);

      const receipts = JSON.parse(await fs.readFile(join(out.runDir, "receipts.json"), "utf8")) as Array<{
        sourceSnapshots?: Array<{ source: string }>;
      }>;
      const sources = receipts.flatMap((r) => r.sourceSnapshots ?? []).map((s) => s.source);
      assert.deepEqual(sources, [fixture.url], "GraphQL receipt source must match the effective POST endpoint");
    } finally {
      fixture.close();
    }
  });
});
