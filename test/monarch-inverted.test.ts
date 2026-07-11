import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { fsCasStore, openBioStore, runBioOperationFromManifest } from "pi-bio-agent";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceManifest = join(repoRoot, "examples", "clinical-genomics", "monarch.manifest.json");
const pinnedMonarchUrl = "https://data.monarchinitiative.org/monarch-kg/2026-04-14/monarch-kg.duckdb";

async function createMonarchFixture(path: string): Promise<void> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    await conn.run(`CREATE TABLE nodes (
      id VARCHAR,
      category VARCHAR,
      name VARCHAR,
      symbol VARCHAR
    )`);
    await conn.run(`CREATE TABLE edges (
      subject VARCHAR,
      predicate VARCHAR,
      object VARCHAR,
      negated VARCHAR,
      primary_knowledge_source VARCHAR,
      frequency_qualifier VARCHAR,
      has_evidence VARCHAR,
      publications VARCHAR
    )`);
    await conn.run(`CREATE TABLE closure (
      subject_id VARCHAR,
      predicate_id VARCHAR,
      object_id VARCHAR
    )`);

    const nodes = [
      ["MONDO:1", "biolink:Disease", "SCN1A disorder", null],
      ["MONDO:2", "biolink:Disease", "Broad seizure disorder", null],
      ["MONDO:3", "biolink:Disease", "Specific seizure disorder", null],
      ["HGNC:10585", "biolink:Gene", "sodium voltage-gated channel alpha subunit 1", "SCN1A"],
      ["HGNC:2", "biolink:Gene", "broad candidate", "BROAD"],
      ["HGNC:3", "biolink:Gene", "specific candidate", "SPECIFIC"],
      ["HP:0001250", "biolink:PhenotypicFeature", "Seizure", null],
      ["HP:0001263", "biolink:PhenotypicFeature", "Global developmental delay", null],
      ["HP:0012638", "biolink:PhenotypicFeature", "Abnormal nervous system physiology", null],
      ["HP:9999999", "biolink:PhenotypicFeature", "Specific seizure subtype", null],
    ];
    for (const row of nodes) await conn.run("INSERT INTO nodes VALUES (?, ?, ?, ?)", row);

    const edges = [
      ["MONDO:1", "biolink:has_phenotype", "HP:0001250", "false", "infores:hpo-annotations", null, "ECO:1", "PMID:1"],
      ["MONDO:1", "biolink:has_phenotype", "HP:0001250", "false", "infores:orphanet", null, "ECO:2", "PMID:4"],
      ["MONDO:1", "biolink:has_phenotype", "HP:0001263", "false", "infores:hpo-annotations", null, "ECO:1", "PMID:2"],
      ["MONDO:2", "biolink:has_phenotype", "HP:0012638", "false", "infores:hpo-annotations", null, "ECO:1", null],
      ["MONDO:2", "biolink:has_phenotype", "HP:0001263", "true", "infores:test", null, null, null],
      ["MONDO:3", "biolink:has_phenotype", "HP:9999999", "false", "infores:hpo-annotations", null, "ECO:1", null],
      ["HGNC:10585", "biolink:causes", "MONDO:1", "false", "infores:omim", null, "ECO:2", "PMID:3"],
      ["HGNC:10585", "biolink:gene_associated_with_condition", "MONDO:1", "false", "infores:orphanet", null, null, null],
      ["HGNC:2", "biolink:gene_associated_with_condition", "MONDO:2", "false", "infores:orphanet", null, null, null],
      ["HGNC:3", "biolink:causes", "MONDO:3", "false", "infores:omim", null, null, null],
    ];
    for (const row of edges) await conn.run("INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row);

    const closure = [
      ["HP:0001250", "rdfs:subClassOf", "HP:0001250"],
      ["HP:0001250", "rdfs:subClassOf", "HP:0012638"],
      ["HP:0001263", "rdfs:subClassOf", "HP:0001263"],
      ["HP:0012638", "rdfs:subClassOf", "HP:0012638"],
      ["HP:9999999", "rdfs:subClassOf", "HP:9999999"],
      ["HP:9999999", "rdfs:subClassOf", "HP:0001250"],
      ["HP:9999999", "rdfs:subClassOf", "HP:0012638"],
    ];
    for (const row of closure) await conn.run("INSERT INTO closure VALUES (?, ?, ?)", row);
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

test("pinned Monarch operation walks canonical edges, nodes, and closure through the recorded run path", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-monarch-"));
  const monarchPath = join(cwd, "monarch-fixture.duckdb");
  await createMonarchFixture(monarchPath);
  const source = `file:${monarchPath}`;
  const manifest = (await fs.readFile(sourceManifest, "utf8")).split(pinnedMonarchUrl).join(source);
  await fs.writeFile(join(cwd, "manifest.json"), manifest);

  const store = await openBioStore(cwd);
  const cas = fsCasStore(join(cwd, ".pi", "bio-agent", "cas"));
  try {
    const response = await runBioOperationFromManifest({
      cwd,
      dbPath: join(cwd, "analysis.duckdb"),
      manifestPath: "manifest.json",
      operationId: "clinical.monarch_phenotype_hypotheses",
      runId: "monarch-canonical-fixture",
      now: "2026-07-11T12:00:00Z",
      bindings: { phenotype_ids: ["HP:0001250", "HP:0001263"], limit: 10 },
      duckdbInitSql: [`ATTACH '${monarchPath.replaceAll("'", "''")}' AS monarch (READ_ONLY)`],
      store: store.conn,
      author: "test:monarch-inverted",
      cas,
      casMetadata: { conn: store.conn },
      serialize: false,
    });
    assert.equal(response.ok, true, response.ok ? undefined : response.error);
    if (!response.ok) return;

    const resultDigest = response.casRefs?.result;
    assert.match(resultDigest ?? "", /^sha256:/);
    const rows = JSON.parse(
      await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: resultDigest!.slice(7) }), "utf8"),
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(
      [rows[0]?.gene, rows[0]?.disease_id, rows[0]?.exact_observed_terms, rows[0]?.matched_observed_terms],
      ["SCN1A", "MONDO:1", 2, 2],
    );
    const byGene = new Map(rows.map((row) => [row.gene, row]));
    assert.deepEqual(
      [byGene.get("BROAD")?.disease_id, byGene.get("BROAD")?.exact_observed_terms, byGene.get("BROAD")?.matched_observed_terms],
      ["MONDO:2", 0, 1],
    );
    assert.deepEqual(
      [byGene.get("SPECIFIC")?.disease_id, byGene.get("SPECIFIC")?.exact_observed_terms, byGene.get("SPECIFIC")?.matched_observed_terms],
      ["MONDO:3", 0, 1],
    );
    assert.match(String(rows[0]?.gene_disease_predicates), /biolink:causes/);
    assert.deepEqual(rows[0]?.phenotype_sources, ["infores:hpo-annotations", "infores:orphanet"]);
    assert.deepEqual(rows[0]?.gene_disease_sources, ["infores:omim", "infores:orphanet"]);
    assert.match(String(byGene.get("BROAD")?.phenotype_match_kinds), /observed_descends_from_annotation/);
    assert.match(String(byGene.get("SPECIFIC")?.phenotype_match_kinds), /annotation_descends_from_observed/);
    assert.ok(
      rows.every((row) => row.disease_label !== "Broad seizure disorder" || row.exact_observed_terms === 0),
      "negated exact assertion is excluded",
    );

    const receiptsDigest = response.casRefs?.receipts;
    assert.match(receiptsDigest ?? "", /^sha256:/);
    const receipts = JSON.parse(
      await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: receiptsDigest!.slice(7) }), "utf8"),
    ) as Array<{ sourceSnapshots?: Array<{ source: string }> }>;
    const sources = receipts.flatMap((receipt) => receipt.sourceSnapshots ?? []).map((snapshot) => snapshot.source);
    assert.ok(sources.length >= 3);
    assert.ok(sources.every((value) => value === source));
    const recorded = await store.conn.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM bio_observations WHERE subject_id = ? AND predicate = 'run'",
      [`run:${response.runId}`],
    );
    assert.equal(Number(recorded[0]?.n ?? 0), 1);
  } finally {
    store.close();
  }
});
