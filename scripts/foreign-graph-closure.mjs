import { DuckDBInstance } from "@duckdb/node-api";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { materializeEntailedEdges } from "../dist/duckdb/graph-closure.js";

// PROOF of the immanent abstraction (docs/refinments.md): an EXTERNAL SQL graph is a `bio_edges` source via ATTACH +
// a subject/predicate/object column map, and the SAME `entailed_edge` closure walks it. We build a small
// Biolink-shaped external DuckDB with canonical subject/predicate/object edges, ATTACH it read-only, project it into
// `bio_edges`, run the real library
// closure, and assert both a direct projected edge and transitive hops the closure had to derive. A best-effort probe
// then checks that a pinned remote Monarch KG exposes the same canonical edge columns. The application-level Monarch
// pattern owns its nodes/edges/closure query and scientific predicate policy.
//
// Run:  npm run build && node scripts/foreign-graph-closure.mjs

const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

async function makeBiolinkExtract(path) {
  const inst = await DuckDBInstance.create(path);
  const c = await inst.connect();
  await c.run("CREATE TABLE edges (subject TEXT, predicate TEXT, object TEXT)");
  const rows = [
    // HP is_a hierarchy (3 levels): Seizure -> Abn. CNS physiology -> Abn. nervous system
    ["HP:0001250", "biolink:subclass_of", "HP:0012638"],
    ["HP:0012638", "biolink:subclass_of", "HP:0000707"],
    // gene -> phenotype (leaf) and gene -> disease
    ["NCBIGene:6323", "biolink:has_phenotype", "HP:0001250"],
    ["NCBIGene:6323", "biolink:gene_associated_with_condition", "MONDO:0100135"],
    // disease -> phenotype
    ["MONDO:0100135", "biolink:has_phenotype", "HP:0001250"],
  ];
  for (const r of rows) await c.run("INSERT INTO edges VALUES (?,?,?)", r);
  c.closeSync(); inst.closeSync();
}

async function main() {
  const extPath = join(tmpdir(), `monarch-extract-${process.pid}.duckdb`);
  await makeBiolinkExtract(extPath);

  const raw = await (await DuckDBInstance.create(":memory:")).connect();
  const conn = duckdbNodeConn(raw);

  // 1) ATTACH the foreign graph read-only, 2) PROJECT it into bio_edges via the column map (subject/predicate/object).
  await raw.run(`ATTACH '${extPath}' AS ext (READ_ONLY)`);
  await conn.run(
    "CREATE TABLE bio_edges AS SELECT subject AS from_id, predicate, object AS to_id FROM ext.edges",
  );
  const direct = Number((await conn.all("SELECT count(*) AS n FROM bio_edges"))[0].n);
  console.log(`  ATTACHed foreign KG + projected ${direct} biolink edges into bio_edges (subject/predicate/object -> from_id/predicate/to_id)`);

  // 3) run the SAME library closure over the subsumption predicate.
  const entailed = await materializeEntailedEdges(conn, ["biolink:subclass_of"]);
  console.log(`  entailed_edge closure over biolink:subclass_of: ${entailed} rows`);

  // 4a) a DIRECT projected edge survived the ATTACH + projection.
  const gp = await conn.all("SELECT 1 FROM bio_edges WHERE from_id='NCBIGene:6323' AND predicate='biolink:has_phenotype' AND to_id='HP:0001250'");
  assert(gp.length === 1, "gene->phenotype direct edge projected from the foreign graph");

  // 4b) the closure DERIVED a transitive hop that is NOT a direct edge (Seizure -> Abnormality of the nervous system).
  const twoHop = await conn.all("SELECT 1 FROM entailed_edge WHERE from_id='HP:0001250' AND to_id='HP:0000707' AND predicate='biolink:subclass_of'");
  const twoHopDirect = await conn.all("SELECT 1 FROM bio_edges WHERE from_id='HP:0001250' AND to_id='HP:0000707'");
  assert(twoHop.length === 1 && twoHopDirect.length === 0, "closure derived the 2-hop subsumption HP:0001250 -> HP:0000707 (not a direct edge)");

  // 4c) the ontology-aware gene walk a clinical-genomics app needs: gene -has_phenotype-> leaf, leaf -subclass*-> ancestor.
  const walk = await conn.all(`
    SELECT p.from_id AS gene, p.to_id AS leaf, e.to_id AS ancestor
    FROM bio_edges p
    JOIN entailed_edge e ON e.from_id = p.to_id AND e.predicate = 'biolink:subclass_of'
    WHERE p.predicate = 'biolink:has_phenotype' AND p.from_id = 'NCBIGene:6323' AND e.to_id = 'HP:0000707'`);
  assert(
    walk.some((r) => r.gene === "NCBIGene:6323" && r.leaf === "HP:0001250" && r.ancestor === "HP:0000707"),
    "gene reaches an ANCESTOR phenotype via has_phenotype + subsumption closure (the phenotype-aware gene walk)",
  );

  console.log("  PROVED: an external ATTACHed graph, projected by column map, is walked by the SAME entailed_edge closure");
  console.log(`    gene NCBIGene:6323 -has_phenotype-> HP:0001250, and HP:0001250 -subclass*-> HP:0000707 (derived), so the gene is phenotype-linked to the ancestor.`);

  await raw.run("DETACH ext");
  await fs.rm(extPath, { force: true });

  // 5) best-effort: the pinned remote Monarch KG is a remote .duckdb with canonical edges. Skip-report on failure.
  try {
    await raw.run("INSTALL httpfs; LOAD httpfs;");
    await raw.run("ATTACH 'https://data.monarchinitiative.org/monarch-kg/2026-04-14/monarch-kg.duckdb' AS monarch (READ_ONLY)");
    const cols = await conn.all("SELECT column_name FROM information_schema.columns WHERE table_catalog='monarch' AND table_name='edges' AND column_name IN ('subject','predicate','object') ORDER BY 1");
    const sample = await conn.all("SELECT predicate FROM monarch.edges LIMIT 1");
    console.log(`  Pinned Monarch remote ATTACH: reachable; edges has ${cols.length}/3 of subject/predicate/object; sample predicate='${sample[0]?.predicate}'. Same projection applies.`);
  } catch (e) {
    console.log(`  Pinned Monarch remote ATTACH: skipped (${String(e).replace(/\s+/g, " ").slice(0, 90)}). Mechanism proven on the extract above.`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
