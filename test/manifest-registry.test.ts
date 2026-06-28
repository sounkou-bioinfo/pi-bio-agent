import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, validateDomainPackManifest, type DomainPackManifest, type SqlConn } from "../src/core/manifest.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

const inlineResolver = { id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize an inline table.", output: { mode: "table" as const } };
const tableParams = (table: string) => ({ table, columns: [{ name: "id", type: "TEXT" }], rows: [{ id: "x" }] });

function baseManifest(over: Partial<DomainPackManifest["provides"]> = {}): DomainPackManifest {
  return {
    schema: "pi-bio.domain_pack_manifest.v1",
    id: "pack-a",
    version: "0.1.0",
    title: "Pack A",
    description: "A test pack.",
    domains: ["genomics"],
    provides: {
      resolvers: [inlineResolver],
      resources: [{ id: "t1", title: "T1", kind: "virtual", resolver: "inline.table", params: tableParams("t1") }],
      ...over,
    },
  };
}
async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("validateDomainPackManifest: fail closed", () => {
  test("accepts a well-formed manifest", () => {
    assert.deepEqual(validateDomainPackManifest(baseManifest()), []);
  });

  test("rejects missing/wrong schema", () => {
    const m = baseManifest();
    assert.ok(validateDomainPackManifest({ ...m, schema: "nope" as never }).some((e) => e.includes("schema must be")));
  });

  test("rejects duplicate ids within a kind", () => {
    const m = baseManifest({ resources: [
      { id: "dup", title: "A", kind: "virtual", resolver: "inline.table", params: tableParams("a") },
      { id: "dup", title: "B", kind: "virtual", resolver: "inline.table", params: tableParams("b") },
    ] });
    assert.ok(validateDomainPackManifest(m).some((e) => e.includes("duplicated within the manifest")));
  });

  test("rejects a resource pointing to an undeclared resolver", () => {
    const m = baseManifest({ resolvers: [], resources: [{ id: "t1", title: "T1", kind: "virtual", resolver: "ghost", params: tableParams("t1") }] });
    assert.ok(validateDomainPackManifest(m).some((e) => e.includes("undeclared resolver 'ghost'")));
  });

  test("rejects an operation requiring an undeclared view/resource", () => {
    const m = baseManifest({ operations: [{
      schema: "pi-bio.operation_spec.v1", id: "op.x", version: "0.1.0", title: "X", description: "x", domains: ["genomics"],
      transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true, requiredViews: ["missing"] },
    }] });
    assert.ok(validateDomainPackManifest(m).some((e) => e.includes("undeclared view/resource 'missing'")));
  });

  test("rejects an invalid operation spec (delegates to validateBioOperationSpec)", () => {
    const m = baseManifest({ operations: [{
      schema: "pi-bio.operation_spec.v1", id: "op.y", version: "0.1.0", title: "Y", description: "y", domains: ["genomics"],
      transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: false as never },
    }] });
    assert.ok(validateDomainPackManifest(m).some((e) => e.includes("sql.readOnly must be true")));
  });
});

describe("registry: registration is fail-closed, frozen, and id-unique", () => {
  test("registerManifest throws on an invalid manifest", () => {
    const r = createBioRegistry();
    assert.throws(() => r.registerManifest({ ...baseManifest(), schema: "x" as never }), /invalid manifest/);
  });

  test("rejects the same id registered twice across manifests", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    const clash: DomainPackManifest = { ...baseManifest(), id: "pack-b", provides: { resolvers: [inlineResolver] } };
    assert.throws(() => r.registerManifest(clash), /id already registered/);
  });

  test("binding an impl for an unknown resolver throws", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    assert.throws(() => r.bindResolverImpl("ghost", inlineTableResolver), /no resolver spec 'ghost'/);
  });

  test("registered specs are cloned + frozen (caller cannot mutate the registry after the fact)", () => {
    const r = createBioRegistry();
    const m = baseManifest();
    r.registerManifest(m);
    m.provides.resources![0]!.params = tableParams("hacked"); // mutate the original
    assert.equal((r.getResource("t1")!.params as { table: string }).table, "t1"); // registry unaffected
    assert.throws(() => { (r.getResource("t1") as { id: string }).id = "evil"; }); // frozen
  });
});

describe("registry.resolveResource: resource-centered, registry-stamped receipts", () => {
  test("stamps identity/provenance the impl cannot forge; params digests distinguish resources", async () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest({ resources: [
      { id: "t1", title: "T1", kind: "virtual", resolver: "inline.table", params: tableParams("t1") },
      { id: "t2", title: "T2", kind: "virtual", resolver: "inline.table", params: tableParams("t2") },
    ] }));
    r.bindResolverImpl("inline.table", inlineTableResolver);
    const conn = await memoryConn();
    const a = await r.resolveResource("t1", { conn, now: "2026-06-28T00:00:00Z" });
    const b = await r.resolveResource("t2", { conn, now: "2026-06-28T00:00:00Z" });
    assert.equal(a.resourceId, "t1");
    assert.equal(a.resolverId, "inline.table");
    assert.equal(a.resolverVersion, "0.1.0");
    assert.equal(a.resolvedAt, "2026-06-28T00:00:00Z");
    assert.match(a.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(a.paramsDigest, b.paramsDigest); // same resolver, different params -> distinguishable in provenance
  });

  test("fails closed on unknown resource and declared-but-unbound resolver", async () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    const conn = await memoryConn();
    await assert.rejects(() => r.resolveResource("nope", { conn }), /no resource 'nope'/);
    await assert.rejects(() => r.resolveResource("t1", { conn }), /no implementation is bound/);
  });
});
