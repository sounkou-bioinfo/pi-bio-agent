import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type BioManifest } from "../src/core/manifest.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbFileScanResolver } from "../src/duckdb/resolvers/duckdb-file-scan.js";
import { materializeEntailedEdges } from "../src/duckdb/graph-closure.js";

// Proof that ingesting a real ontology needs NO DuckDB sqlite extension. The canonical SemanticSQL schema is
// LinkML: base tables such as statements/prefix/entailed_edge plus generated views such as
// edge(subject,predicate,object). This fixture models the post-view edge rows as CSV, ingests them with the
// EXISTING duckdb.file_scan resolver (native read_csv), maps the SemanticSQL column names to ours in ONE line of
// SQL (dialect = data), computes our own closure, and grounds + expands — all native, no extension, no new ingest
// code. (The same holds for OBO Graphs JSON via read_json, generated TSVs, or triple parquet — file_scan reads
// them all.)

const manifest: BioManifest = {
  schema: "pi-bio.manifest.v1", id: "ontology-ingest", version: "0.1.0",
  title: "Ontology ingest (SemanticSQL triples via CSV)", description: "Ingest flat ontology triples natively.",
  provides: {
    resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a DuckDB-native file into a table.", output: { mode: "table" } }],
    resources: [
      { id: "ontology_statements", title: "Ontology statements", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "test/fixtures/ontology_statements.csv", table: "statements" } },
      { id: "ontology_edges", title: "Ontology edges", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "test/fixtures/ontology_edges.csv", table: "edge_raw" } },
    ],
  },
};

const GROUND = "SELECT subject FROM statements WHERE predicate IN ('rdfs:label','oio:hasExactSynonym') AND lower(value) = lower(?)";

describe("ontology ingest: SemanticSQL triples in via native file_scan, no sqlite extension", () => {
  test("file_scan loads the triples; one SQL line maps to our shape; closure + grounding work end to end", async () => {
    const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const r = createBioRegistry();
    r.registerManifest(manifest);
    r.bindResolverImpl("duckdb.file_scan", duckdbFileScanResolver);

    // native ingest — read_csv, no extension; the resolver stamps a receipt for each
    const sReceipt = await r.resolveResource("ontology_statements", { conn, now: "t" });
    await r.resolveResource("ontology_edges", { conn, now: "t" });
    assert.ok(sReceipt.sourceSnapshots.some((x) => x.source === "duckdb.read_csv_auto"));

    // SemanticSQL edge(subject,predicate,object) -> our bio_edges(from_id,predicate,to_id): dialect is one SQL line
    await conn.run("CREATE TABLE bio_edges AS SELECT subject AS from_id, predicate, object AS to_id FROM edge_raw");
    const closed = await materializeEntailedEdges(conn, ["rdfs:subClassOf"]);
    assert.equal(closed, 4); // 3 direct is-a edges + 1 transitive (status asthmaticus -> asthma)

    // ground an exact SYNONYM to its CURIE, then expand to ALL transitive descendants — pure SQL over the
    // ingested triples; no ontology runtime, no sqlite, no network
    const grounded = await conn.all<{ subject: string }>(GROUND, ["bronchial asthma"]);
    assert.deepEqual(grounded.map((x) => x.subject), ["MONDO:0004979"]);

    const desc = await conn.all<{ from_id: string }>(
      "SELECT from_id FROM entailed_edge WHERE to_id = 'MONDO:0004979' AND predicate = 'rdfs:subClassOf' ORDER BY from_id",
    );
    assert.deepEqual(desc.map((x) => x.from_id), ["MONDO:0004766", "MONDO:0004784", "MONDO:0005405"]);
  });
});
