import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { materializeBioEdgesAsOf, observationAsOfKey } from "../src/duckdb/observations.js";
import { recordHostEvent } from "../src/hosts/host-events.js";

const NOW = "2026-07-06T10:00:00.000Z";

async function conn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("recordHostEvent", () => {
  test("records an open host-owned event kind as an observation plus ordinary graph links", async () => {
    const c = await conn();
    const out = await recordHostEvent(c, {
      subjectId: "session:s1",
      kind: "workbench.input.steer",
      recordedAt: NOW,
      source: "test-host",
      digest: "sha256:" + "a".repeat(64),
      value: { payload_digest: "sha256:" + "b".repeat(64), delivery: "mid_turn" },
      attrs: { channel: "ui" },
      links: [
        { predicate: "affects", objectId: "turn:s1:a1", attrs: { reason: "user_steer" } },
        { predicate: "context_sent_to", objectId: "model_call:s1:a1" },
      ],
    });

    assert.match(out.observationId, /^sha256:/);
    assert.equal(out.linkObservationIds.length, 2);

    const row = await observationAsOfKey(c, out.statementKey, "9999-12-31T23:59:59.999Z");
    assert.ok(row);
    assert.equal(row!.predicate, "host_event");
    assert.equal(row!.source, "test-host");
    assert.deepEqual(JSON.parse(row!.value_json!), {
      kind: "workbench.input.steer",
      value: { payload_digest: "sha256:" + "b".repeat(64), delivery: "mid_turn" },
    });
    assert.deepEqual(JSON.parse(row!.attrs!), { channel: "ui", kind: "workbench.input.steer" });

    await materializeBioEdgesAsOf(c, "2026-07-06T10:00:01.000Z");
    const edges = await c.all<{ from_id: string; predicate: string; to_id: string; attrs: string | null }>(
      `SELECT from_id, predicate, to_id, attrs FROM bio_edges_as_of
       WHERE from_id = 'session:s1' ORDER BY predicate, to_id`,
    );
    assert.deepEqual(edges.map((e) => [e.from_id, e.predicate, e.to_id]), [
      ["session:s1", "affects", "turn:s1:a1"],
      ["session:s1", "context_sent_to", "model_call:s1:a1"],
    ]);
    const attrs = JSON.parse(edges[0]!.attrs!);
    assert.equal(attrs.host_event_kind, "workbench.input.steer");
    assert.equal(attrs.host_event_statement_key, out.statementKey);
    assert.equal(attrs.host_event_observation_id, out.observationId);
  });

  test("does not require or recognize a core event taxonomy", async () => {
    const c = await conn();
    await recordHostEvent(c, {
      subjectId: "workflow:w1",
      kind: "scheduler.vendor.signal:lease-lost",
      recordedAt: NOW,
      value: { lease: "attempt-2" },
    });
    const rows = await c.all<{ kind: string }>(
      `SELECT json_extract_string(value_json, '$.kind') AS kind
       FROM bio_observations WHERE predicate = 'host_event'`,
    );
    assert.deepEqual(rows.map((r) => r.kind), ["scheduler.vendor.signal:lease-lost"]);
  });

  test("default identity is stable across object key order", async () => {
    const c = await conn();
    const a = await recordHostEvent(c, {
      subjectId: "workflow:w2",
      kind: "workbench.context.digest",
      recordedAt: NOW,
      value: { b: 2, a: { z: 3, y: 4 } },
    });
    const b = await recordHostEvent(c, {
      subjectId: "workflow:w2",
      kind: "workbench.context.digest",
      recordedAt: NOW,
      value: { a: { y: 4, z: 3 }, b: 2 },
    });

    assert.equal(a.statementKey, b.statementKey);
    assert.equal(a.observationId, b.observationId);
    const rows = await c.all<{ n: bigint }>("SELECT count(*) AS n FROM bio_observations WHERE predicate = 'host_event'");
    assert.equal(Number(rows[0]!.n), 1, "same semantic event payload dedupes despite object key order");
  });

  test("fails closed on empty identities and invalid timestamps", async () => {
    const c = await conn();
    await assert.rejects(
      () => recordHostEvent(c, { subjectId: "session:s1", kind: "   ", recordedAt: NOW }),
      /kind must be non-empty/,
    );
    await assert.rejects(
      () => recordHostEvent(c, { subjectId: "session:s1", kind: "host.signal", recordedAt: "not-a-time" }),
      /DuckDB-castable TIMESTAMPTZ/,
    );
  });

  test("rejects malformed links before writing a partial host event", async () => {
    const c = await conn();
    await recordHostEvent(c, { subjectId: "session:s1", kind: "host.ok", recordedAt: NOW });
    const before = await c.all<{ n: bigint }>("SELECT count(*) AS n FROM bio_observations");

    await assert.rejects(
      () => recordHostEvent(c, {
        subjectId: "session:s1",
        kind: "host.bad-link",
        recordedAt: NOW,
        links: [{ predicate: "   ", objectId: "turn:s1:a1" }],
      }),
      /link\.predicate must be non-empty/,
    );
    await assert.rejects(
      () => recordHostEvent(c, {
        subjectId: "session:s1",
        kind: "host.bad-link",
        recordedAt: NOW,
        links: [{ predicate: "affects", objectId: "   " }],
      }),
      /link\.objectId must be non-empty/,
    );

    const after = await c.all<{ n: bigint }>("SELECT count(*) AS n FROM bio_observations");
    assert.equal(Number(after[0]!.n), Number(before[0]!.n), "bad links did not leave scalar host_event rows behind");
  });
});
