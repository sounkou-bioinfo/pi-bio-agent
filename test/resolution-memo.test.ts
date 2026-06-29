import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbFileScanResolver } from "../src/duckdb/resolvers/duckdb-file-scan.js";
import { duckdbSqlMaterializeResolver } from "../src/duckdb/resolvers/duckdb-sql-materialize.js";

// Resolution memoization (the lazy graph's memo table): re-resolving an UNCHANGED file skips the re-read +
// re-load and replays the receipt — proven by resolvedAt staying the ORIGINAL value, not the new now. Changing
// the file invalidates the memo. Correct because the key is content freshness (mtime+size), not the path alone
// (the {targets}/ETag lesson: a params-only memo would serve stale data).

describe("resolution memoization (file_scan): unchanged file hits, changed file misses", () => {
  test("an unchanged file replays the receipt; a modified file re-resolves", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "memo-"));
    const csv = join(dir, "v.csv");
    await fs.writeFile(csv, "g,n\nBRCA1,1\n", "utf8");
    const conn: SqlConn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const resource: VirtualResourceSpec = { id: "v", title: "V", kind: "virtual", resolver: "duckdb.file_scan", params: { path: csv, table: "v" } };

    const first = await duckdbFileScanResolver(resource, { conn, now: "T1" });
    assert.equal(first.sourceSnapshots[0]!.retrievedAt, "T1");

    // file unchanged -> cache hit: the receipt is replayed (resolvedAt stays T1 even though now=T2)
    const second = await duckdbFileScanResolver(resource, { conn, now: "T2" });
    assert.equal(second.sourceSnapshots[0]!.retrievedAt, "T1", "unchanged file must be a memo hit (replayed receipt)");

    // change the file -> freshness token changes -> miss -> real re-resolve at T3 that sees the new data
    await new Promise((r) => setTimeout(r, 5)); // ensure mtime advances
    await fs.writeFile(csv, "g,n\nBRCA1,1\nTP53,2\n", "utf8");
    const third = await duckdbFileScanResolver(resource, { conn, now: "T3" });
    assert.equal(third.sourceSnapshots[0]!.retrievedAt, "T3", "modified file must miss the memo and re-resolve");
    const [{ n }] = await conn.all<{ n: number }>("SELECT count(*) AS n FROM v");
    assert.equal(Number(n), 2);
  });

  test("the memo is a shared primitive: sql_materialize over local declaredSources hits/misses the same way", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "memo-sql-"));
    const csv = join(dir, "s.csv");
    await fs.writeFile(csv, "g,n\nBRCA1,1\n", "utf8");
    const conn: SqlConn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const r = (): VirtualResourceSpec => ({ id: "m", title: "M", kind: "virtual", resolver: "duckdb.sql_materialize", params: { table: "m", sql: `SELECT * FROM read_csv_auto('${csv}')`, declaredSources: [`file:${csv}`] } });

    const first = await duckdbSqlMaterializeResolver(r(), { conn, now: "T1" });
    assert.equal(first.sourceSnapshots[0]!.retrievedAt, "T1");
    const second = await duckdbSqlMaterializeResolver(r(), { conn, now: "T2" });
    assert.equal(second.sourceSnapshots[0]!.retrievedAt, "T1", "unchanged source -> memo hit");

    await new Promise((res) => setTimeout(res, 5));
    await fs.writeFile(csv, "g,n\nBRCA1,1\nTP53,2\n", "utf8");
    const third = await duckdbSqlMaterializeResolver(r(), { conn, now: "T3" });
    assert.equal(third.sourceSnapshots[0]!.retrievedAt, "T3", "changed source -> miss");
    const [{ n }] = await conn.all<{ n: number }>("SELECT count(*) AS n FROM m");
    assert.equal(Number(n), 2);
  });
});
