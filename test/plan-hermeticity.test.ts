import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { sqlReadsOnlyResolvedTables, resolvedBaseTables, sqlUsesNonDeterministicFn, hermeticIntrospectionUsable, __resetHermeticIntrospectionCache } from "../src/duckdb/plan-hermeticity.js";

// A SOUND hermeticity proof over the DuckDB physical PLAN: a query is hermetic iff every data-source leaf is a
// base-table scan of a RESOLVED table (or a pure/constant source) — no file/table-function/replacement-scan read.
// Un-evadable: comments, quoted identifiers, and replacement scans all resolve to the same plan operators.
async function conn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await c.run("CREATE TABLE variants AS SELECT 1 AS x, 'a' AS c");
  await c.run("CREATE TABLE genes AS SELECT 'TP53' AS symbol");
  return c;
}

describe("plan-hermeticity: prove a query reads only resolved tables (via EXPLAIN plan)", () => {
  test("resolvedBaseTables returns the base tables in main", async () => {
    const c = await conn();
    assert.deepEqual([...(await resolvedBaseTables(c))].sort(), ["genes", "variants"]);
  });

  test("a scan of ONLY resolved tables is hermetic (incl. joins, aggregates, quoted alias, comments)", async () => {
    const c = await conn();
    const t = await resolvedBaseTables(c);
    for (const sql of [
      "SELECT count(*) FROM variants",
      "SELECT count(*) AS \"n\" FROM variants", // quoted alias — no new source
      "SELECT count(*) /* comment */ FROM variants -- trailing",
      "SELECT * FROM variants v JOIN genes g ON true",
      "WITH s AS (SELECT * FROM variants) SELECT count(*) FROM s",
      "SELECT 1 AS one", // constant, no data source
    ]) {
      assert.equal(await sqlReadsOnlyResolvedTables(c, sql, t), true, `hermetic: ${sql}`);
    }
  });

  test("ANY ambient read is NON-hermetic — even hidden behind a comment/quote (caught at the PLAN, not the text)", async () => {
    const c = await conn();
    const t = await resolvedBaseTables(c);
    for (const sql of [
      "SELECT * FROM generate_series(1, 3)", // table function
      "SELECT * FROM /* hide */ generate_series(1, 3)", // comment can't hide it from the plan
      "SELECT * FROM read_csv_auto('/etc/hostname')", // file reader
      "SELECT count(*) FROM variants UNION ALL SELECT * FROM generate_series(1,2)", // ambient in one branch
    ]) {
      assert.equal(await sqlReadsOnlyResolvedTables(c, sql, t), false, `non-hermetic: ${sql}`);
    }
  });

  test("scanning an UNRESOLVED table is non-hermetic (the table isn't in the pinned set)", async () => {
    const c = await conn();
    // prove against a set that does NOT include `genes`
    assert.equal(await sqlReadsOnlyResolvedTables(c, "SELECT * FROM genes", new Set(["variants"])), false);
  });

  test("FAIL CLOSED: an un-EXPLAINable / erroring query is treated as non-hermetic", async () => {
    const c = await conn();
    const t = await resolvedBaseTables(c);
    assert.equal(await sqlReadsOnlyResolvedTables(c, "SELECT * FROM no_such_table", t), false);
    assert.equal(await sqlReadsOnlyResolvedTables(c, "this is not sql", t), false);
  });

  test("non-deterministic functions (AST + stability, not regex): random/now/uuid flagged, incl. quoted; pure not", async () => {
    const c = await conn();
    // deterministic: no function, or only CONSISTENT functions/operators/aggregates -> false (safe to memoize)
    for (const sql of [
      "SELECT count(*) FROM variants WHERE x > 25",
      "SELECT upper(c), abs(x) FROM variants GROUP BY 1, 2",
      "SELECT x + 1 AS y FROM variants",
    ]) assert.equal(await sqlUsesNonDeterministicFn(c, sql), false, `deterministic: ${sql}`);
    // non-deterministic: VOLATILE (random/uuid/gen_random_uuid) or CONSISTENT_WITHIN_QUERY (now/current_timestamp)
    for (const sql of [
      "SELECT random() AS r FROM variants",
      'SELECT "random"() AS r FROM variants', // QUOTED — the AST normalizes it; a regex would miss it
      "SELECT uuid() FROM variants",
      "SELECT now() FROM variants",
      "SELECT current_timestamp AS t FROM variants",
      "SELECT count(*) FROM variants WHERE x < random()", // buried in a predicate
    ]) assert.equal(await sqlUsesNonDeterministicFn(c, sql), true, `non-deterministic: ${sql}`);
    // FAIL CLOSED on unparseable SQL (json_serialize_sql returns an error JSON, not a throw)
    assert.equal(await sqlUsesNonDeterministicFn(c, "this is not sql"), true);
    // an embedded single quote is escaped, not a break-out
    assert.equal(await sqlUsesNonDeterministicFn(c, "SELECT c FROM variants WHERE c = 'a''b'"), false);
  });

  test("introspection self-check passes on the current DuckDB build (a parser/plan-format change would flip it -> memo OFF)", async () => {
    __resetHermeticIntrospectionCache();
    const c = await conn();
    // On THIS build the probes agree (volatile flagged, pure not, table-function caught) -> introspection is usable.
    // If a future DuckDB renamed the AST `function_name` key or a plan operator, one probe would disagree and this
    // returns false — which run-store uses to disable memoization (fail safe) rather than risk a wrong memo.
    assert.equal(await hermeticIntrospectionUsable(c), true);
    __resetHermeticIntrospectionCache();
  });
});
