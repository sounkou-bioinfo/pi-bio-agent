import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";

// The SemanticSQL grounding path, end to end, over a synthetic MONDO-shaped ontology — the PROJECTION tier:
// deterministic, offline, pure SQL. `statements(subject, predicate, value)` carries labels/synonyms; the
// is-a edges live in the shared `bio_edges` base; `entailed_edge` is their transitive closure. Grounding a
// term (text -> CURIE) and expanding it (descendants) are both plain SELECTs — no ontology runtime, no
// recursion at query time, no external download. This is exactly how an imported ontology and our own graph
// share one substrate. (The JUDGMENT tier — decideGrounding over a fresh OLS4 candidate set on a miss — is
// tested separately; here every term is already known, so projection answers without abstaining.)

const STATEMENTS: Array<[string, string, string]> = [
  ["MONDO:0004979", "rdfs:label", "asthma"],
  ["MONDO:0004979", "oio:hasExactSynonym", "bronchial asthma"],
  ["MONDO:0004784", "rdfs:label", "allergic asthma"],
  ["MONDO:0005405", "rdfs:label", "childhood onset asthma"],
  ["MONDO:0004766", "rdfs:label", "status asthmaticus"],
];
// is-a DAG: status asthmaticus -> allergic asthma -> asthma ; childhood onset asthma -> asthma
const EDGES: Array<[string, string, string]> = [
  ["MONDO:0004784", "rdfs:subClassOf", "MONDO:0004979"],
  ["MONDO:0005405", "rdfs:subClassOf", "MONDO:0004979"],
  ["MONDO:0004766", "rdfs:subClassOf", "MONDO:0004784"],
];

async function ontologyConn(): Promise<SqlConn> {
  const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await conn.run("CREATE TABLE statements (subject TEXT, predicate TEXT, value TEXT)");
  for (const [s, p, v] of STATEMENTS) await conn.run("INSERT INTO statements VALUES (?, ?, ?)", [s, p, v]);
  await conn.run("CREATE TABLE bio_edges (from_id TEXT, to_id TEXT, predicate TEXT)");
  for (const [f, p, t] of EDGES) await conn.run("INSERT INTO bio_edges (from_id, predicate, to_id) VALUES (?, ?, ?)", [f, p, t]);
  return conn;
}

// text -> CURIE over labels + exact synonyms (case-insensitive), the SemanticSQL grounding entry point
const GROUND = "SELECT subject FROM statements WHERE predicate IN ('rdfs:label','oio:hasExactSynonym') AND lower(value) = lower(?)";

describe("ontology grounding over SemanticSQL (projection tier): text->CURIE + descendants, all SQL", () => {
  test("grounds a label and an exact synonym to the same CURIE", async () => {
    const conn = await ontologyConn();
    const byLabel = await conn.all<{ subject: string }>(GROUND, ["asthma"]);
    const bySyn = await conn.all<{ subject: string }>(GROUND, ["Bronchial Asthma"]); // case-insensitive synonym
    assert.deepEqual(byLabel.map((r) => r.subject), ["MONDO:0004979"]);
    assert.deepEqual(bySyn.map((r) => r.subject), ["MONDO:0004979"]);
  });

  test("expands a grounded term to ALL descendants (transitive) via entailed_edge — one join", async () => {
    const conn = await ontologyConn();
    await materializeEntailedEdges(conn, ["rdfs:subClassOf"]);
    // ground 'asthma', then every is-a descendant — including the transitive 'status asthmaticus'
    const rows = await conn.all<{ subject: string; label: string }>(
      `WITH grounded AS (${GROUND})
       SELECT e.from_id AS subject, s.value AS label
       FROM grounded g
       JOIN entailed_edge e ON e.to_id = g.subject AND e.predicate = 'rdfs:subClassOf'
       JOIN statements s ON s.subject = e.from_id AND s.predicate = 'rdfs:label'
       ORDER BY subject`,
      ["asthma"],
    );
    assert.deepEqual(rows.map((r) => r.subject), ["MONDO:0004766", "MONDO:0004784", "MONDO:0005405"]);
    assert.ok(rows.some((r) => r.label === "status asthmaticus"), "transitive (grandchild) descendant is included");
  });

  test("an unknown term grounds to nothing — projection returns empty, the caller abstains (never invents a CURIE)", async () => {
    const conn = await ontologyConn();
    const rows = await conn.all<{ subject: string }>(GROUND, ["myocardial infarction"]);
    assert.equal(rows.length, 0);
  });
});
