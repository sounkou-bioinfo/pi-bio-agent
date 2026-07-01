import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateBioOperationSpec, type BioOperationSpec } from "../src/core/operation-spec.js";
import { validateBioManifest, type BioManifest } from "../src/core/manifest.js";
import { findDuckDbExtensions } from "../src/duckdb/extensions.js";

// Regression guard for the domain-pack cut: `domains` is gone from every schema, and extension search runs over
// REAL declaration content (name/source/purpose/notes/examples), not a taxonomy tag. A stray `domains` key must
// fail closed under the strict-manifest doctrine (not ride as inert JSON).

describe("domain-pack cut: no domains field, search over real content", () => {
  test("a manifest/operation/tool without `domains` validates", () => {
    const manifest: BioManifest = {
      schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "M", description: "d",
      provides: { resolvers: [{ id: "r", version: "0.1.0", title: "R", description: "d", output: { mode: "table" } }] },
    };
    assert.deepEqual(validateBioManifest(manifest), []);
    const op: BioOperationSpec = {
      id: "op.x", version: "0.1.0", title: "Op", description: "d",
      transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true },
    };
    assert.deepEqual(validateBioOperationSpec(op), []);
  });

  test("a stray `domains` key now fails closed as unknown (not inert JSON)", () => {
    const manifest = {
      schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "M", description: "d",
      domains: ["genomics"], provides: {},
    } as never;
    assert.ok(validateBioManifest(manifest).some((e) => /unknown key 'domains'/.test(e)));
  });

  test("extension search finds by name, purpose, and example SQL", () => {
    assert.ok(findDuckDbExtensions("duckhts").some((e) => e.name === "duckhts"), "by name");
    assert.ok(findDuckDbExtensions("PLINK").some((e) => e.name === "plinking_duck"), "by purpose text");
    assert.ok(findDuckDbExtensions("read_bcf").some((e) => e.name === "duckhts"), "by example SQL");
  });
});
