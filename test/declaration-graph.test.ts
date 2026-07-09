import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { BioManifest } from "../src/core/manifest.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeBioEdgesAsOf } from "../src/duckdb/observations.js";
import { manifestDeclarationIds, recordManifestDeclarations } from "../src/hosts/declaration-graph.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

describe("manifest declaration graph", () => {
  test("projects declarations and dependencies as idempotent ledger facts", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const raw = await instance.connect();
    const conn = duckdbNodeConn(raw);
    try {
      const manifest = JSON.parse(await readFile("examples/rare-high-impact/manifest.json", "utf8")) as BioManifest;
      const ids = manifestDeclarationIds(manifest);
      await recordManifestDeclarations(conn, { manifest, recordedAt: "2026-07-09T00:00:00Z", source: "agent:test" });
      await recordManifestDeclarations(conn, { manifest, recordedAt: "2026-07-09T01:00:00Z", source: "agent:test" });
      await materializeBioEdgesAsOf(conn, MEMORY_NOW);

      const declarations = await conn.all<{ subject_id: string }>("SELECT subject_id FROM bio_observations WHERE predicate = 'declaration'");
      assert.equal(declarations.length, 5, "one manifest, one resolver, two resources, and one operation");
      const edges = await conn.all<{ from_id: string; predicate: string; to_id: string }>(
        "SELECT from_id, predicate, to_id FROM bio_edges_as_of ORDER BY from_id, predicate, to_id",
      );
      assert.ok(edges.some((edge) => edge.from_id === ids.manifest && edge.predicate === "provides" && edge.to_id === ids.operations["rare_high_impact.report"]));
      assert.ok(edges.some((edge) => edge.from_id === ids.operations["rare_high_impact.report"] && edge.predicate === "requires" && edge.to_id === ids.resources.annotated_variants));
      assert.ok(edges.some((edge) => edge.from_id === ids.resources.annotated_variants && edge.predicate === "resolved_by" && edge.to_id === ids.resolvers["duckdb.file_scan"]));
    } finally {
      raw.closeSync();
      instance.closeSync();
    }
  });

  test("resolver and operation declarations are manifest-scoped rather than conflated by a reused id/version", () => {
    const base = JSON.parse(JSON.stringify({
      schema: "pi-bio.manifest.v1", version: "0.1.0", title: "Manifest", description: "Manifest",
      provides: {
        resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "Scan", description: "Scan", output: { mode: "table" } }],
        operations: [{ id: "records.summary", version: "0.1.0", title: "Summary", description: "Summary", transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true } }],
      },
    })) as BioManifest;
    const first = manifestDeclarationIds({ ...base, id: "first" });
    const second = manifestDeclarationIds({ ...base, id: "second" });
    assert.notEqual(first.resolvers["duckdb.file_scan"], second.resolvers["duckdb.file_scan"]);
    assert.notEqual(first.operations["records.summary"], second.operations["records.summary"]);
  });

  test("a recorded run links to the manifest and resources it actually used", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const raw = await instance.connect();
    const store = duckdbNodeConn(raw);
    try {
      const run = await runBioQueryFromManifest({
        cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json",
        sql: "SELECT count(*) AS n FROM variants", resources: ["variants"], runId: "declaration-run",
        now: "2026-07-09T00:00:00Z", store, author: "agent:test",
      });
      assert.equal(run.ok, true);
      await materializeBioEdgesAsOf(store, MEMORY_NOW);
      const edges = await store.all<{ predicate: string; to_id: string }>(
        "SELECT predicate, to_id FROM bio_edges_as_of WHERE from_id = 'run:declaration-run' ORDER BY predicate, to_id",
      );
      assert.ok(edges.some((edge) => edge.predicate === "uses_manifest" && edge.to_id.startsWith("manifest:variant-counts@")));
      assert.ok(edges.some((edge) => edge.predicate === "uses_resource" && edge.to_id.includes(":variants")));
    } finally {
      raw.closeSync();
      instance.closeSync();
    }
  });
});
