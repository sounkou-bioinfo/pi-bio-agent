import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";

// The HONEST, fuller RLM shape — map then reduce, with the hard parts the GROUP-BY example skipped:
//  (1) SEMANTIC labeling: rows arrive UNLABELED (free text). The label is INFERRED by a worker (the judgment
//      boundary — an LM in a live run; a rule here). This is the part RLM actually uses recursive LM calls for.
//  (2) A real TOPOLOGY: partition -> parallel map over workers -> reduce. Not one flat query.
//  (3) A WRITE case, boundary-correct: workers PRODUCE label artifacts and never touch the db; the HOST is the
//      SINGLE WRITER that merges them into a `labels` table. So concurrent workers never contend for the
//      process-exclusive RW lock (DuckDB process-boundary analysis) — only the host writes.
// Only AFTER labels exist is the distributional query a deterministic GROUP BY.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

// stands in for the semantic judgment a sub-agent would do (live: an LM labels each row; here: a rule)
const ruleLabel = (instance: string): string => {
  const s = instance.toLowerCase();
  if (s.includes("how many") || s.includes("how old")) return "number";
  if (s.includes("who")) return "human";
  if (s.includes("where")) return "location";
  if (s.includes("define")) return "description";
  return "entity";
};
// a worker labels a PARTITION and returns artifacts only — it does NOT write the database
const labelWorker = async (rows: Array<{ id: number; instance: string }>): Promise<Array<{ id: number; label: string }>> =>
  rows.map((r) => ({ id: Number(r.id), label: ruleLabel(r.instance) }));

describe("map-reduce labeling: the honest RLM shape (semantic map + host-single-writer reduce)", () => {
  test("partition -> parallel label workers (no db writes) -> host merges labels -> deterministic aggregate", async () => {
    const conn = await memoryConn();
    await conn.run("CREATE TABLE unlabeled(id INTEGER, instance VARCHAR)");
    const rows: Array<[number, string]> = [
      [1, "How many moons orbit Mars"], [2, "Who painted the ceiling"], [3, "Where is the capital city"],
      [4, "Define a covalent bond"], [5, "How old is the universe"], [6, "Who invented calypso"],
      [7, "Where is the river"], [8, "What planet is red"], [9, "How many years in a decade"], [10, "Who wrote the play"],
    ];
    for (const [id, instance] of rows) await conn.run("INSERT INTO unlabeled VALUES (?, ?)", [id, instance]);

    // MAP: read partitions, run workers concurrently. Workers receive rows and return labels — they never write.
    const all = await conn.all<{ id: number; instance: string }>("SELECT id, instance FROM unlabeled ORDER BY id");
    const mid = Math.ceil(all.length / 2);
    const partitions = [all.slice(0, mid), all.slice(mid)];
    const labelChunks = await Promise.all(partitions.map(labelWorker)); // "parallel agents", each isolated to its partition
    const labels = labelChunks.flat();

    // REDUCE: the HOST (single writer) merges the workers' label artifacts into the db. No worker wrote it.
    await conn.run("CREATE TABLE labels(id INTEGER, label VARCHAR)");
    for (const { id, label } of labels) await conn.run("INSERT INTO labels VALUES (?, ?)", [id, label]);

    // Only NOW is the distributional query a deterministic GROUP BY — over the inferred labels.
    const agg = await conn.all<{ label: string; n: number | bigint }>(
      "SELECT label, count(*) AS n FROM unlabeled JOIN labels USING (id) GROUP BY label ORDER BY label",
    );
    const counts = Object.fromEntries(agg.map((r) => [r.label, Number(r.n)]));
    // number: 1,5,9 ; human: 2,6,10 ; location: 3,7 ; description: 4 ; entity: 8
    assert.deepEqual(counts, { description: 1, entity: 1, human: 3, location: 2, number: 3 });
  });
});
