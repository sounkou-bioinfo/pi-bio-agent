import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BioManifest } from "../src/core/manifest.js";
import { assessManifestHost, resourceCapabilityRequirements } from "../src/hosts/manifest-capabilities.js";

const manifest = (resolver: string, params: Record<string, unknown>): BioManifest => ({
  schema: "pi-bio.manifest.v1",
  id: "capability-test",
  version: "0.1.0",
  title: "Capability test",
  description: "Exercise host admission without executing a source.",
  provides: {
    resolvers: [{ id: resolver, version: "0.1.0", title: resolver, description: resolver, output: { mode: "table" } }],
    resources: [{ id: "records", title: "Records", kind: "virtual", resolver, params }],
    operations: [{
      id: "records.summary",
      version: "0.1.0",
      title: "Summary",
      description: "Summarize records.",
      transport: "duckdb.sql",
      inputSchema: { type: "object" },
      sql: { sqlTemplate: "SELECT count(*) AS n FROM records", readOnly: true, requiredResources: ["records"] },
    }],
  },
});

describe("manifest host assessment", () => {
  test("network admission uses declared source fields, not arbitrary string scanning inside opaque params", () => {
    const resource = {
      id: "records", title: "Records", kind: "virtual" as const, resolver: "duckdb.sql_materialize",
      params: { table: "records", sql: "SELECT 'https://example.test/not-a-source' AS note", extensions: ["httpfs"] },
    };
    assert.deepEqual(resourceCapabilityRequirements(resource), ["duckdb.extension.httpfs"]);
    assert.deepEqual(resourceCapabilityRequirements({
      ...resource,
      params: { ...resource.params, declaredSources: ["https://example.test/data.parquet"] },
    }), ["duckdb.extension.httpfs", "network.egress"]);
  });

  test("an unbound host-injected resolver blocks its operation", () => {
    const out = assessManifestHost(manifest("http.get", { url: "https://example.test/data.json", table: "records" }), {
      resolverBindings: new Set(),
    });
    assert.equal(out.resources[0]!.admission, "blocked");
    assert.equal(out.operations[0]!.admission, "blocked");
    assert.match(out.operations[0]!.reasons.join("\n"), /no host binding/);
  });

  test("an injected fetch makes http.get admission ready without claiming the source request will succeed", () => {
    const out = assessManifestHost(manifest("http.get", { url: "https://example.test/data.json", table: "records" }), {
      resolverBindings: new Set(["http.get"]),
      capabilities: { "host.fetch": "available" },
    });
    assert.equal(out.resources[0]!.admission, "ready");
    assert.equal(out.operations[0]!.admission, "ready");
  });

  test("a bound extension-backed resolver stays unknown until the host attests the extension", () => {
    const spec = manifest("duckhts.read_bcf", { path: "data/example.vcf.gz", table: "records" });
    const unknown = assessManifestHost(spec, { resolverBindings: new Set(["duckhts.read_bcf"]) });
    assert.equal(unknown.operations[0]!.admission, "unknown");
    assert.match(unknown.operations[0]!.reasons.join("\n"), /duckdb\.extension\.duckhts.*not been attested/);

    const blocked = assessManifestHost(spec, {
      resolverBindings: new Set(["duckhts.read_bcf"]),
      capabilities: { "duckdb.extension.duckhts": "unavailable" },
    });
    assert.equal(blocked.operations[0]!.admission, "blocked");

    const ready = assessManifestHost(spec, {
      resolverBindings: new Set(["duckhts.read_bcf"]),
      capabilities: { "duckdb.extension.duckhts": "available" },
    });
    assert.equal(ready.operations[0]!.admission, "ready");
  });
});
