import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { listManifestCatalog } from "../src/hosts/manifest-catalog.js";

describe("manifest catalog: source discovery is manifest-backed, not connector code", () => {
  test("lists validated packaged manifests with table, operation, and capability hints", async () => {
    const catalog = await listManifestCatalog({ cwd: process.cwd(), root: "examples", query: "clinvar" });
    assert.equal(catalog.schema, "pi-bio.manifest_catalog.v2");
    assert.equal(catalog.root, "examples");
    assert.equal(catalog.invalid.length, 0);
    assert.ok(catalog.entries.length >= 1);
    const clinvar = catalog.entries.find((entry) => entry.id === "connector-clinvar-region");
    assert.ok(clinvar, "ClinVar region manifest is discoverable by query");
    assert.equal(clinvar.manifestPath, "examples/connectors/clinvar-region.json");
    assert.deepEqual(clinvar.resources.map((r) => ({ id: r.id, resolver: r.resolver, table: r.table })), [
      { id: "clinvar", resolver: "duckhts.read_bcf", table: "clinvar" },
    ]);
    assert.ok(clinvar.requirements.includes("duckdb.extension.duckhts"));
    assert.ok(clinvar.requirements.includes("network.egress"));
  });

  test("discovers GraphQL and operation manifests without per-source TypeScript connectors", async () => {
    const catalog = await listManifestCatalog({ cwd: process.cwd(), root: "examples", query: "graphql" });
    const openTargets = catalog.entries.find((entry) => entry.id === "connector-opentargets-graphql");
    assert.ok(openTargets);
    assert.deepEqual(openTargets.operations.map((op) => ({ id: op.id, requiredResources: op.requiredResources })), [
      { id: "opentargets.associated_diseases", requiredResources: ["opentargets_target_associated_diseases"] },
    ]);
    assert.deepEqual(openTargets.resolverIds, ["duckdb.sql_materialize"]);
    assert.ok(openTargets.requirements.includes("duckdb.extension.ducknng"));
    assert.ok(openTargets.requirements.includes("network.egress"));
  });

  test("can include invalid pi-bio manifests as validation data for host/catalog maintainers", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-catalog-"));
    await fs.writeFile(join(root, "bad.json"), JSON.stringify({
      schema: "pi-bio.manifest.v1",
      id: "bad",
      version: "0.1.0",
      title: "Bad",
      description: "Invalid manifest",
      provides: { resources: "not-an-array" },
    }), "utf8");
    await fs.writeFile(join(root, "other.json"), JSON.stringify({ schema: "not-pi-bio" }), "utf8");

    const hidden = await listManifestCatalog({ cwd: process.cwd(), root });
    assert.deepEqual(hidden.invalid, []);

    const visible = await listManifestCatalog({ cwd: process.cwd(), root, includeInvalid: true });
    assert.equal(visible.entries.length, 0);
    assert.equal(visible.invalid.length, 1);
    assert.match(visible.invalid[0]!.errors.join("\n"), /resources must be an array/);
  });
});
