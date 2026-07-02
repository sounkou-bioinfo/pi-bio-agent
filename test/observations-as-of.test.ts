import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, recordObservation, observationsAsOf, materializeBioEdgesAsOf, entailedEdgesAsOf } from "../src/duckdb/observations.js";

// Phase 4.0a: the append-only temporal provenance-statement store. The load-bearing property is
// latest-per-statement_key (NOT per triple) — so supersession works even when the OBJECT or the VALUE changes.
const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-06-01T00:00:00Z";

async function newConn(): Promise<SqlConn> {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
}

describe("bio_observations: temporal provenance statements, as-of latest-per-statement_key", () => {
  test("as-of ordering is TEMPORAL, not lexicographic — mixed ISO forms (…Z vs …sssZ) sort correctly", async () => {
    const c = await newConn();
    const key = "state:x";
    // '…01.500Z' is temporally LATER than '…01Z' (=…01.000Z), but lexicographically SMALLER ('.' < 'Z') — so a
    // TEXT sort would wrongly pick '…01Z' as current. TIMESTAMPTZ comparison must pick the '…01.500Z' row.
    await recordObservation(c, { statementKey: key, subjectId: "x", predicate: "p", value: "correct-latest", recordedAt: "2026-01-01T00:00:01.500Z" });
    await recordObservation(c, { statementKey: key, subjectId: "x", predicate: "p", value: "stale-earlier", recordedAt: "2026-01-01T00:00:01Z" });
    const rows = await observationsAsOf(c, "2026-06-01T00:00:00Z");
    const cur = rows.find((r) => r.statement_key === key);
    assert.equal(JSON.parse(cur!.value_json!), "correct-latest", "the temporally-latest row wins, not the lexicographically-largest");
  });


  test("supersession across a CHANGING OBJECT (the activation case partition-by-triple would break)", async () => {
    const c = await newConn();
    await recordObservation(c, { statementKey: "activation:operation:foo", subjectId: "operation:foo", predicate: "active_version", objectId: "operation:foo@v1", recordedAt: T1 });
    await recordObservation(c, { statementKey: "activation:operation:foo", subjectId: "operation:foo", predicate: "active_version", objectId: "operation:foo@v2", recordedAt: T2 });

    const atT1 = await observationsAsOf(c, T1);
    assert.equal(atT1.find((r) => r.statement_key === "activation:operation:foo")!.object_id, "operation:foo@v1", "as-of T1: v1 is active");
    const atT2 = await observationsAsOf(c, T2);
    assert.equal(atT2.find((r) => r.statement_key === "activation:operation:foo")!.object_id, "operation:foo@v2", "as-of T2: v2 superseded v1 — even though the OBJECT changed");
    // rollback = append a row pointing at the OLD version
    const T3 = "2026-09-01T00:00:00Z";
    await recordObservation(c, { statementKey: "activation:operation:foo", subjectId: "operation:foo", predicate: "active_version", objectId: "operation:foo@v1", recordedAt: T3 });
    assert.equal((await observationsAsOf(c, T3)).find((r) => r.statement_key === "activation:operation:foo")!.object_id, "operation:foo@v1", "rollback: append, not mutate");
  });

  test("supersession across a CHANGING VALUE (a coloc PP.H4 update)", async () => {
    const c = await newConn();
    const key = "coloc:locus1:Whole_Blood:PP.H4";
    await recordObservation(c, { statementKey: key, subjectId: "coloc:locus1:Whole_Blood", predicate: "posterior:PP.H4", value: 0.5, recordedAt: T1 });
    await recordObservation(c, { statementKey: key, subjectId: "coloc:locus1:Whole_Blood", predicate: "posterior:PP.H4", value: 0.91, recordedAt: T2 });
    assert.equal((await observationsAsOf(c, T1)).find((r) => r.statement_key === key)!.value_json, "0.5");
    assert.equal((await observationsAsOf(c, T2)).find((r) => r.statement_key === key)!.value_json, "0.91");
  });

  test("duplicate triple is ALLOWED (not unique-per-triple) and exact re-record is idempotent", async () => {
    const c = await newConn();
    const base = { statementKey: "k", subjectId: "s", predicate: "p", objectId: "o" };
    const id1 = await recordObservation(c, { ...base, recordedAt: T1 });
    const id2 = await recordObservation(c, { ...base, recordedAt: T2 }); // SAME triple, different time -> a NEW row
    assert.notEqual(id1, id2);
    const idDup = await recordObservation(c, { ...base, recordedAt: T1 }); // EXACT same -> idempotent
    assert.equal(idDup, id1);
    const [{ n }] = await c.all<{ n: number }>("SELECT count(*) AS n FROM bio_observations WHERE subject_id='s' AND predicate='p'");
    assert.equal(Number(n), 2, "two rows for the same triple (different times); the exact dup did not add a third");
  });

  test("edge-like statements project into bio_edges_as_of and the SAME closure walks the as-of graph", async () => {
    const c = await newConn();
    // a small is-a chain asserted at T1: A -> B -> C
    await recordObservation(c, { statementKey: "isa:A:B", subjectId: "A", predicate: "rdfs:subClassOf", objectId: "B", recordedAt: T1 });
    await recordObservation(c, { statementKey: "isa:B:C", subjectId: "B", predicate: "rdfs:subClassOf", objectId: "C", recordedAt: T1 });
    // a SCALAR observation must NOT become an edge
    await recordObservation(c, { statementKey: "coloc:x:PP.H4", subjectId: "x", predicate: "posterior:PP.H4", value: 0.9, recordedAt: T1 });

    const edges = await materializeBioEdgesAsOf(c, T1);
    assert.equal(edges, 2, "two edge-like statements projected; the scalar one is excluded");
    const n = await entailedEdgesAsOf(c, T1, ["rdfs:subClassOf"]);
    assert.ok(n >= 3, `closure includes the transitive A->C (got ${n} entailed edges)`);
    const reach = await c.all<{ to_id: string }>("SELECT to_id FROM entailed_edge_as_of WHERE from_id='A' AND predicate='rdfs:subClassOf' ORDER BY to_id");
    assert.deepEqual(reach.map((r) => r.to_id), ["B", "C"], "A reaches B AND (transitively) C as of T1");
  });
});
