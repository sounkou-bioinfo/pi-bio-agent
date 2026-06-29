import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { duckdbSqlMaterializeResolver } from "../src/duckdb/resolvers/duckdb-sql-materialize.js";

// The {targets} "DuckDB-over-files" aggregation pattern — the validated go-to for "many inputs -> one value":
// write a file per shard/sample, then read them as one table and aggregate. In our substrate that is just
// duckdb.sql_materialize over a GLOB; no bespoke combine step, no per-shard TypeScript. This is THE common
// bioinformatics shape (merge N per-sample tables) and it falls out of the general resolver for free.

describe("multi-file aggregation: many shards -> one table via sql_materialize (the targets DuckDB pattern)", () => {
  test("a glob reads every shard into one table; a query aggregates across all of them", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "shards-"));
    // three "branch outputs" — same schema, different samples (as if produced by parallel per-sample steps)
    await fs.writeFile(join(dir, "sample_A.csv"), "sample,gene,counts\nA,BRCA1,10\nA,TP53,4\n", "utf8");
    await fs.writeFile(join(dir, "sample_B.csv"), "sample,gene,counts\nB,BRCA1,7\nB,TP53,9\n", "utf8");
    await fs.writeFile(join(dir, "sample_C.csv"), "sample,gene,counts\nC,BRCA1,3\nC,TP53,5\n", "utf8");

    const conn: SqlConn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "duckdb.sql_materialize", params });

    // ONE resolver, a glob in the declared SQL — materializes all shards into a single table
    const out = await duckdbSqlMaterializeResolver(resource({
      table: "expression",
      sql: `SELECT * FROM read_csv_auto('${join(dir, "*.csv")}')`,
      declaredSources: [`file:${join(dir, "*.csv")}`],
    }), { conn, now: "t" });
    assert.equal(out.result.pointer?.uri, "table:expression");

    // every shard is present: 3 samples x 2 genes = 6 rows
    const [{ n }] = await conn.all<{ n: number }>("SELECT count(*) AS n FROM expression");
    assert.equal(Number(n), 6);

    // aggregate across all shards — total counts per gene, the answer the operation SQL gives
    const perGene = await conn.all<{ gene: string; total: number }>("SELECT gene, sum(counts) AS total FROM expression GROUP BY gene ORDER BY gene");
    assert.deepEqual(perGene.map((r) => [r.gene, Number(r.total)]), [
      ["BRCA1", 20], // 10 + 7 + 3
      ["TP53", 18], // 4 + 9 + 5
    ]);
  });
});
