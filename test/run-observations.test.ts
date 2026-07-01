import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey } from "../src/duckdb/observations.js";
import { recordRunObservation } from "../src/hosts/run-observations.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};

describe("run-observations: ad-hoc SQL folds into the ONE store as an as-of, attributed observation", () => {
  test("a query run becomes a run:<id> observation carrying its exact SQL, status, and author", async () => {
    const c = await conn();
    await recordRunObservation(c, { runId: "q1", kind: "query", identity: "ad-hoc.query", status: "succeeded", sql: "SELECT count(*) FROM variants", resources: ["variants"] }, "2026-01-01T00:00:01Z", "agent:A");
    const row = await observationAsOfKey(c, "run:q1", MEMORY_NOW);
    assert.ok(row, "the run is recorded in the store");
    assert.equal(row!.source, "agent:A"); // attributed
    const v = JSON.parse(row!.value_json!);
    assert.equal(v.status, "succeeded");
    assert.equal(v.sql, "SELECT count(*) FROM variants"); // the exact ad-hoc SQL is queryable, not just in a file
  });
});
