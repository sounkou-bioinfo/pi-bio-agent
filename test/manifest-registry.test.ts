import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, validateDomainPackManifest, type DomainPackManifest } from "../src/core/manifest.js";
import type { SqlConn } from "../src/core/ports.js";
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

  test("strict admission: rejects smuggled sprawl keys at every level (no inert JSON)", () => {
    // a manifest is the program — cut surface (reportKind/requiredColumns/columnRoles/mapper) must not ride
    // along as ignored keys that a future reader might honor; an unknown key fails closed.
    const topLevel = { ...baseManifest(), reportKind: "bucketed" } as never;
    assert.ok(validateDomainPackManifest(topLevel).some((e) => e.includes("unknown key 'reportKind'")));

    const onResource = baseManifest({ resources: [{ id: "t1", title: "T1", kind: "virtual", resolver: "inline.table", params: tableParams("t1"), columnRoles: { af: "x" } } as never] });
    assert.ok(validateDomainPackManifest(onResource).some((e) => e.includes("unknown key 'columnRoles'")));

    const onSql = baseManifest({ operations: [{
      schema: "pi-bio.operation_spec.v1", id: "op1", version: "0.1.0", title: "Op", description: "d", domains: ["genomics"],
      transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: "SELECT 1 AS x FROM t1", readOnly: true, requiredResources: ["t1"], requiredColumns: ["x"] } as never,
    }] });
    assert.ok(validateDomainPackManifest(onSql).some((e) => e.includes("unknown key 'requiredColumns'")));

    // opacity is still allowed where core declared it: resource.params and the operation's JSON inputSchema
    const opaqueOk = baseManifest({ resources: [{ id: "t1", title: "T1", kind: "virtual", resolver: "inline.table", params: { ...tableParams("t1"), anything: { nested: true } } }] });
    assert.deepEqual(validateDomainPackManifest(opaqueOk), []);
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

  test("rejects an operation requiring an undeclared resource", () => {
    const m = baseManifest({ operations: [{
      schema: "pi-bio.operation_spec.v1", id: "op.x", version: "0.1.0", title: "X", description: "x", domains: ["genomics"],
      transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true, requiredResources: ["missing"] },
    }] });
    assert.ok(validateDomainPackManifest(m).some((e) => e.includes("undeclared resource 'missing'")));
  });

  test("rejects term sets with an untitled set, empty member id, or duplicate member id", () => {
    const ts = (members: Array<{ id: string; label?: string }>, title = "T") => baseManifest({ termSets: [{ id: "ts1", title, members }] });
    assert.ok(validateDomainPackManifest(ts([{ id: "A:1" }], "")).some((e) => e.includes("requires a title")));
    assert.ok(validateDomainPackManifest(ts([{ id: "" }])).some((e) => e.includes("empty id")));
    assert.ok(validateDomainPackManifest(ts([{ id: "A:1" }, { id: "A:1" }])).some((e) => e.includes("duplicate member id 'A:1'")));
    assert.deepEqual(validateDomainPackManifest(ts([{ id: "A:1" }, { id: "A:2" }])), []);
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
    assert.throws(() => r.registerManifest(clash), /id 'inline.table' is already registered/);
  });

  test("rejects re-registering the same manifest id", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    assert.throws(() => r.registerManifest({ ...baseManifest(), provides: { operations: [] } }), /manifest id 'pack-a' is already registered/);
  });

  test("registration is atomic: a colliding manifest leaves the registry untouched", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    // pack-b reuses resolver id inline.table (collision) but also brings a fresh op that must NOT leak in.
    const partial: DomainPackManifest = { ...baseManifest(), id: "pack-b", provides: {
      resolvers: [inlineResolver],
      operations: [{ schema: "pi-bio.operation_spec.v1", id: "op.leak", version: "0.1.0", title: "L", description: "l", domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" }, sql: { sqlTemplate: "SELECT 1", readOnly: true } }],
    } };
    assert.throws(() => r.registerManifest(partial), /already registered/);
    assert.equal(r.getOperation("op.leak"), undefined); // nothing from the failed manifest committed
  });

  test("binding an impl for an unknown resolver throws", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    assert.throws(() => r.bindResolverImpl("ghost", inlineTableResolver), /no resolver spec 'ghost'/);
  });

  test("rejects rebinding a resolver impl unless replace is set", () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    r.bindResolverImpl("inline.table", inlineTableResolver);
    assert.throws(() => r.bindResolverImpl("inline.table", inlineTableResolver), /already has a bound impl/);
    assert.doesNotThrow(() => r.bindResolverImpl("inline.table", inlineTableResolver, { replace: true }));
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

  test("paramsDigest is canonical: identical params in different key order yield the same digest", async () => {
    // identity must be content-based, not key-order-based — otherwise a trivial reordering would look like a
    // different resource (breaking caching/dedup) even though it resolves the same thing.
    const r = createBioRegistry();
    const columns = [{ name: "id", type: "TEXT" }];
    const rows = [{ id: "x" }];
    r.registerManifest(baseManifest({ resources: [
      { id: "ord1", title: "Ordered 1", kind: "virtual", resolver: "inline.table", params: { table: "same", columns, rows } },
      { id: "ord2", title: "Ordered 2", kind: "virtual", resolver: "inline.table", params: { rows, columns, table: "same" } },
    ] }));
    r.bindResolverImpl("inline.table", inlineTableResolver);
    const conn = await memoryConn();
    const a = await r.resolveResource("ord1", { conn, now: "t" });
    const b = await r.resolveResource("ord2", { conn, now: "t" });
    assert.equal(a.paramsDigest, b.paramsDigest);
  });

  test("fails closed on unknown resource and declared-but-unbound resolver", async () => {
    const r = createBioRegistry();
    r.registerManifest(baseManifest());
    const conn = await memoryConn();
    await assert.rejects(() => r.resolveResource("nope", { conn }), /no resource 'nope'/);
    await assert.rejects(() => r.resolveResource("t1", { conn }), /no implementation is bound/);
  });
});
