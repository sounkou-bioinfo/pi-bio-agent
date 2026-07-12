import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { inferQueryResourceClosure, inferQueryResources } from "../src/core/resource-forcing.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";

const resources: VirtualResourceSpec[] = [
  {
    id: "local_input",
    title: "Local input",
    kind: "virtual",
    resolver: "duckdb.file_scan",
    params: { table: "local_input" },
  },
  {
    id: "derived",
    title: "Derived foreign-catalog join",
    kind: "virtual",
    resolver: "duckdb.sql_materialize",
    params: {
      table: "derived",
      sql: "SELECT g.id FROM ensembl.gene g JOIN local_input l ON l.id = g.id",
    },
  },
];

describe("query resource forcing", () => {
  let instance: DuckDBInstance;
  let raw: DuckDBConnection;
  let conn: SqlConn;

  before(async () => {
    instance = await DuckDBInstance.create(":memory:");
    raw = await instance.connect();
    conn = duckdbNodeConn(raw);
  });

  after(() => {
    raw.closeSync();
    instance.closeSync();
  });

  test("keeps qualified host catalogs outside the manifest resource dependency closure", async () => {
    const inferred = await inferQueryResourceClosure(conn, "SELECT * FROM derived", resources);
    assert.deepEqual(inferred.resources, ["local_input", "derived"]);
    assert.deepEqual(inferred.tables, ["derived"]);
  });

  test("allows direct qualified host-catalog reads without forcing a same-named local resource", async () => {
    const sameNamed = [{ ...resources[0]!, params: { table: "gene" } }];
    const inferred = await inferQueryResources(conn, "SELECT * FROM ensembl.gene", sameNamed);
    assert.deepEqual(inferred, { resources: [], tables: [] });
  });

  test("recognizes main-qualified manifest outputs", async () => {
    const inferred = await inferQueryResources(conn, "SELECT * FROM main.local_input", resources);
    assert.deepEqual(inferred, { resources: ["local_input"], tables: ["local_input"] });
  });

  test("forces a resource before pragma-based schema discovery", async () => {
    const inferred = await inferQueryResources(conn, "SELECT name FROM pragma_table_info('local_input')", resources);
    assert.deepEqual(inferred, { resources: ["local_input"], tables: ["local_input"] });
  });

  test("continues to reject unknown unqualified tables", async () => {
    await assert.rejects(
      () => inferQueryResources(conn, "SELECT * FROM undeclared", resources),
      /table reference\(s\) not declared as manifest resource outputs: undeclared/,
    );
  });
});
