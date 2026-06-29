import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { httpTableResolver, type FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";

// The generic HTTP resolver, exercised with an INJECTED mock fetch — no live network. This is the judgment
// tier's transport: a fresh text->CURIE search (OLS4-shaped here) comes back as JSON, is materialized into a
// candidate table, and is then ground/ranked by SQL + decideGrounding. The resolver is generic — the URL and
// shape are manifest DATA, not an OLS4-specific client.

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "http.get", params });
const okJson = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe("http.get: one generic HTTP resolver (injected fetch, no ambient network)", () => {
  test("materializes a JSON response into a queryable candidate table + stamps a digest receipt", async () => {
    const conn = await memoryConn();
    // an OLS4-style search result, flattened to candidate rows the grounding boundary consumes
    const fetchImpl = okJson([
      { obo_id: "MONDO:0004979", label: "asthma" },
      { obo_id: "MONDO:0004784", label: "allergic asthma" },
    ]);
    const out = await httpTableResolver(fetchImpl)(resource({ url: "https://www.ebi.ac.uk/ols4/api/search?q=asthma", table: "candidates", format: "json" }), { conn, now: "t" });

    const rows = await conn.all<{ obo_id: string; label: string }>("SELECT obo_id, label FROM candidates ORDER BY obo_id");
    assert.deepEqual(rows.map((r) => r.obo_id), ["MONDO:0004784", "MONDO:0004979"]);
    // receipt records the URL and a sha256 of the exact bytes fetched
    assert.equal(out.sourceSnapshots[0]!.source, "https://www.ebi.ac.uk/ols4/api/search?q=asthma");
    assert.match(out.sourceSnapshots[0]!.version ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(out.result.mode, "reference");
  });

  test("fails closed: non-2xx, a non-http URL, and an unknown format", async () => {
    const conn = await memoryConn();
    const notFound: FetchLike = async () => ({ ok: false, status: 404, text: async () => "" });
    await assert.rejects(() => httpTableResolver(notFound)(resource({ url: "https://x/y", table: "t", format: "json" }), { conn, now: "t" }), /status 404/);
    await assert.rejects(() => httpTableResolver(okJson([]))(resource({ url: "file:///etc/passwd", table: "t" }), { conn, now: "t" }), /http\(s\) URL/);
    await assert.rejects(() => httpTableResolver(okJson([]))(resource({ url: "https://x/y", table: "t", format: "xml" }), { conn, now: "t" }), /unknown format/);
  });

  test("never reaches the network on its own — fetch is injected; a throwing fetch surfaces, nothing ambient", async () => {
    const conn = await memoryConn();
    const exploding: FetchLike = async () => { throw new Error("network call attempted"); };
    // proves the resolver only ever uses the injected fetch (no hidden global fetch / httpfs)
    await assert.rejects(() => httpTableResolver(exploding)(resource({ url: "https://x/y", table: "t" }), { conn, now: "t" }), /network call attempted/);
  });
});
