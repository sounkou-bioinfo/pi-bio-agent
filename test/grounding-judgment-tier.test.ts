import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import type { TermSet } from "../src/core/manifest.js";
import { decideGrounding, JudgeContractError } from "../src/core/judgment.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { httpTableResolver, type FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";

// The grounding JUDGMENT tier, end to end and fully offline. The projection tier (cached CURIEs + exact/
// synonym match + entailed_edge) is tested elsewhere; this is the MISS path: fetch fresh candidates over the
// generic http.get resolver (OLS4-shaped), turn the rows into a transient candidate TermSet, and let
// decideGrounding rule — ground a real candidate, abstain on null, and REJECT an invented CURIE. The model is
// a mock (no LLM); fetch is a mock (no network). Substrate decides; the model only proposes.

const OLS4_CANDIDATES = [
  { obo_id: "MONDO:0004979", label: "asthma" },
  { obo_id: "MONDO:0004784", label: "allergic asthma" },
];
const okJson = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "http.get", params });

async function fetchCandidateTermSet(): Promise<TermSet> {
  const conn: SqlConn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await httpTableResolver(okJson(OLS4_CANDIDATES))(resource({ url: "https://www.ebi.ac.uk/ols4/api/search?q=asthma", table: "candidates", format: "json" }), { conn, now: "t" });
  const rows = await conn.all<{ obo_id: string; label: string }>("SELECT obo_id, label FROM candidates ORDER BY obo_id");
  return { id: "ols4:asthma", title: "OLS4 search: asthma", members: rows.map((r) => ({ id: r.obo_id, label: r.label })) };
}

describe("grounding judgment tier: fresh http.get candidates -> decideGrounding (ground / abstain / reject)", () => {
  test("grounds the model's choice when it is one of the freshly fetched candidates", async () => {
    const ts = await fetchCandidateTermSet();
    const decided = decideGrounding({ chosen: "MONDO:0004979", confidence: 0.9 }, ts);
    assert.equal(decided.status, "grounded");
    assert.equal(decided.chosen?.id, "MONDO:0004979");
    assert.equal(decided.chosen?.label, "asthma");
  });

  test("abstains when the model declines (null) or is below the confidence floor", async () => {
    const ts = await fetchCandidateTermSet();
    assert.equal(decideGrounding({ chosen: null }, ts).status, "abstained");
    assert.equal(decideGrounding({ chosen: "MONDO:0004979", confidence: 0.2 }, ts, { minConfidence: 0.5 }).status, "abstained");
  });

  test("rejects an invented CURIE — the model cannot mint an id outside the fetched candidate set", async () => {
    const ts = await fetchCandidateTermSet();
    assert.throws(() => decideGrounding({ chosen: "MONDO:9999999", confidence: 0.99 }, ts), JudgeContractError);
  });
});
