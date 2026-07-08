import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { GraphProjectionProfile } from "../src/core/graph-projection.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeGraphProjectionProfile } from "../src/duckdb/graph-projection.js";
import { runBioOperationFromManifest } from "../src/hosts/run-store.js";

const MANIFEST = resolve(process.cwd(), "examples", "monarch-kg-http", "manifest.json");
const MONARCH_SOURCE = "https://data.monarchinitiative.org/monarch-kg/2026-04-14/tsv/all_associations/disease_to_phenotypic_feature_association.all.tsv.gz";
const PROVISION = ["LOAD httpfs"];

const TSV = [
  "subject\tsubject_label\tsubject_category\tsubject_taxon\tsubject_taxon_label\tnegated\tpredicate\tobject\tobject_label\tobject_category\tqualifiers\tpublications\thas_evidence\tprimary_knowledge_source\taggregator_knowledge_source",
  "MONDO:0007947\tMarfan syndrome\tbiolink:Disease\t\t\tfalse\tbiolink:has_phenotype\tHP:0001083\tEctopia lentis\tbiolink:PhenotypicFeature\tfrequency_qualifier=biolink:Frequent\tPMID:28050285\tECO:0006017\tinfores:omim\t['infores:monarchinitiative','infores:hpo-annotations']",
  "MONDO:0007947\tMarfan syndrome\tbiolink:Disease\t\t\tfalse\tbiolink:has_phenotype\tHP:0002616\tAortic root aneurysm\tbiolink:PhenotypicFeature\t\tPMID:33436942\tECO:0006017\tinfores:omim\t['infores:monarchinitiative','infores:hpo-annotations']",
  "MONDO:0007947\tMarfan syndrome\tbiolink:Disease\t\t\ttrue\tbiolink:has_phenotype\tHP:9999999\tNegated fixture phenotype\tbiolink:PhenotypicFeature\t\t\t\tinfores:test\t['infores:test']",
  "MONDO:0000001\tdisease\tbiolink:Disease\t\t\tfalse\tbiolink:has_phenotype\tHP:0000118\tPhenotypic abnormality\tbiolink:PhenotypicFeature\t\t\t\tinfores:mondo\t['infores:monarchinitiative']",
].join("\n") + "\n";

const httpfsAvailable = await (async () => {
  try {
    const inst = await DuckDBInstance.create(":memory:");
    const c = await inst.connect();
    await c.run("LOAD httpfs");
    inst.closeSync();
    return true;
  } catch {
    return false;
  }
})();

async function startFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/tab-separated-values; charset=utf-8" });
    res.end(TSV);
  });
  await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  return {
    url: `http://127.0.0.1:${addr.port}/disease_to_phenotypic_feature_association.all.tsv`,
    close: () => new Promise<void>((resolveClose, reject) => (server as Server).close((err) => (err ? reject(err) : resolveClose()))),
  };
}

async function manifestWithSource(cwd: string, source: string): Promise<string> {
  const raw = await fs.readFile(MANIFEST, "utf8");
  assert.ok(raw.includes(MONARCH_SOURCE), "fixture manifest patch must track the example source URL");
  const path = join(cwd, "manifest.json");
  await fs.writeFile(path, raw.split(MONARCH_SOURCE).join(source));
  return path;
}

describe("example: Monarch KG downloads over HTTP -> SemanticSQL edge projection", { skip: httpfsAvailable ? false : "httpfs unavailable" }, () => {
  test("materializes a Monarch KGX TSV from HTTP, queries it, and projects it into bio_edges", async () => {
    const fixture = await startFixture();
    try {
      const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-monarch-"));
      const dbPath = join(cwd, "graph.duckdb");
      const manifestPath = await manifestWithSource(cwd, fixture.url);
      const out = await runBioOperationFromManifest({
        cwd,
        dbPath,
        manifestPath,
        operationId: "monarch.disease_phenotypes",
        duckdbInitSql: PROVISION,
        bindings: { disease_id: "MONDO:0007947", limit: 10 },
        runId: "monarch-fixture",
        now: "2026-07-06T12:00:00.000Z",
      });
      assert.equal(out.ok, true, out.ok ? undefined : out.error);
      if (!out.ok) return;
      const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as {
        rows: Array<{ disease_id: string; phenotype_id: string; phenotype_label: string; primary_source: string }>;
      };
      assert.deepEqual(result.rows, [
        { disease_id: "MONDO:0007947", disease_label: "Marfan syndrome", phenotype_id: "HP:0001083", phenotype_label: "Ectopia lentis", predicate: "biolink:has_phenotype", primary_source: "infores:omim" },
        { disease_id: "MONDO:0007947", disease_label: "Marfan syndrome", phenotype_id: "HP:0002616", phenotype_label: "Aortic root aneurysm", predicate: "biolink:has_phenotype", primary_source: "infores:omim" },
      ]);
      const receipts = JSON.parse(await fs.readFile(join(out.runDir, "receipts.json"), "utf8")) as Array<{
        sourceSnapshots?: Array<{ source: string }>;
      }>;
      const sources = receipts.flatMap((r) => r.sourceSnapshots ?? []).map((s) => s.source);
      assert.deepEqual(sources, [fixture.url], "declared provenance must match the URL actually read by SQL");

      const conn = duckdbNodeConn(await (await DuckDBInstance.create(dbPath)).connect());
      const profile: GraphProjectionProfile = {
        schema: "pi-bio.graph_projection_profile.v1",
        id: "monarch-disease-phenotype-fixture",
        title: "Monarch disease phenotype fixture",
        source: { kind: "foreign_kg", table: "monarch_disease_phenotype_edges" },
        columns: { from: "subject", predicate: "predicate", to: "object", attrs: "attrs", trust: "trust" },
        target: { edgesTable: "bio_edges" },
        provenance: [{ source: fixture.url, deid: "not_applicable" }],
      };
      const projected = await materializeGraphProjectionProfile(conn, profile);
      assert.equal(projected.edgeCount, 2, "the negated edge and other disease are filtered before projection");
      const rows = await conn.all<{ from_id: string; predicate: string; to_id: string; source: string; qualifiers: string | null }>(
        "SELECT from_id, predicate, to_id, json_extract_string(attrs, '$.primary_knowledge_source') AS source, json_extract_string(attrs, '$.qualifiers') AS qualifiers FROM bio_edges ORDER BY to_id",
      );
      assert.deepEqual(rows, [
        { from_id: "MONDO:0007947", predicate: "biolink:has_phenotype", to_id: "HP:0001083", source: "infores:omim", qualifiers: "frequency_qualifier=biolink:Frequent" },
        { from_id: "MONDO:0007947", predicate: "biolink:has_phenotype", to_id: "HP:0002616", source: "infores:omim", qualifiers: null },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
