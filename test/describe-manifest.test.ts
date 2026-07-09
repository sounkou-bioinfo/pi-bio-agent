import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeManifest, type BioManifest } from "../src/core/manifest.js";
import { describeBioManifestFromPath } from "../src/hosts/run-store.js";

describe("describeManifest: the 'describe THIS program' view", () => {
  test("summarizes declarations without pretending to know host runnability", () => {
    const m: BioManifest = {
      schema: "pi-bio.manifest.v1",
      id: "x",
      version: "0.1.0",
      title: "X",
      description: "d",
      provides: {
        resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "scan", description: "", output: { mode: "table" } }],
        resources: [{ id: "variants", title: "Variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "v.csv", table: "variants" } }],
        operations: [{ id: "counts.by_consequence", version: "0.1.0", title: "Counts", description: "count", transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true } }],
        termSets: [{ id: "impact", title: "Impact", ordered: true, members: [{ id: "HIGH", rank: 1 }, { id: "LOW", rank: 2 }] }],
      },
    };
    const d = describeManifest(m);
    assert.deepEqual(d.resources, [{ id: "variants", title: "Variants", resolver: "duckdb.file_scan" }]);
    assert.equal(d.operations[0].id, "counts.by_consequence");
    assert.deepEqual(d.operations[0].requiredResources, []);
    assert.equal("runnable" in d.operations[0], false);
    assert.deepEqual(d.termSets, [{ id: "impact", title: "Impact", ordered: true, members: 2 }]);
  });
});

describe("describeBioManifestFromPath: the agent discovery tool (no raw-JSON parsing)", () => {
  test("describes a real example manifest and assesses its actual host bindings", async () => {
    const out = await describeBioManifestFromPath({ cwd: process.cwd(), manifestPath: "examples/rare-high-impact/manifest.json" });
    assert.equal(out.valid, true);
    if (out.valid) {
      assert.ok(out.operations.some((o) => o.id === "rare_high_impact.report"));
      assert.equal(out.host.operations.find((o) => o.id === "rare_high_impact.report")?.admission, "ready");
      assert.ok(out.resources.length >= 1);
    }
  });

  test("returns errors (never throws) for a missing file", async () => {
    const out = await describeBioManifestFromPath({ cwd: process.cwd(), manifestPath: "examples/does-not-exist.json" });
    assert.equal(out.valid, false);
    if (!out.valid) assert.ok(out.errors.length >= 1);
  });

  test("describes a manifest fetched over http when the host grants network", async () => {
    const manifest = { schema: "pi-bio.manifest.v1", id: "remote", version: "0.1.0", title: "Remote", description: "d", provides: { operations: [{ id: "op.x", version: "0.1.0", title: "X", description: "d", transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true } }] } };
    const network = { fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(manifest) }) };
    const out = await describeBioManifestFromPath({ cwd: process.cwd(), manifestPath: "https://example.org/m.json", network });
    assert.equal(out.valid, true);
    if (out.valid) assert.equal(out.host.operations.find((o) => o.id === "op.x")?.admission, "ready");
  });

  test("a URL manifest fails closed with no network — error returned, not thrown", async () => {
    const out = await describeBioManifestFromPath({ cwd: process.cwd(), manifestPath: "https://example.org/m.json" });
    assert.equal(out.valid, false);
    if (!out.valid) assert.match(out.errors.join(" "), /network/);
  });
});
