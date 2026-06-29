import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// Honest tag: this folds in metacurator's `disambiguate` (https://github.com/seandavi/metacurator) — ground a
// text term to ONE provided CURIE or abstain — NOT a ClawBio skill (ClawBio has no standalone OLS skill). The
// bet made concrete: that grounding skill is just examples/ols4-grounding/manifest.json + one SQL query, no
// OLS4-specific code. This runs the REAL example manifest end-to-end through the host with an INJECTED mock
// fetch (no live network): http.get resource -> materialized candidate table -> grounding SQL the agent writes.
// Network is the host's opt-in by COMPOSITION (here the test injects a fetch; the Pi extension's networked
// entrypoint does in production).

// repo-root-anchored: npm test compiles to dist-test/ and runs from the repo root, so cwd is the repo root
// in both the compiled and the tsx runners (import.meta.dirname differs between them).
const MANIFEST = resolve(process.cwd(), "examples", "ols4-grounding", "manifest.json");

// an OLS4-search-shaped response, flattened to the candidate rows the grounding SQL consumes
let lastUrl = "";
const ols4Mock = (etag: string): FetchLike => async (url, init) => {
  lastUrl = url;
  const h = { get: (n: string) => (n.toLowerCase() === "etag" ? etag : null) };
  if (init?.headers?.["If-None-Match"] === etag) return { ok: false, status: 304, text: async () => "", headers: h };
  const body = [
    { obo_id: "MONDO:0004979", label: "asthma" },
    { obo_id: "MONDO:0004784", label: "allergic asthma" },
    { obo_id: "MONDO:0011805", label: "asthma-related traits" },
  ];
  return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: h };
};

describe("example: an OLS4 grounding skill is a manifest, not code", () => {
  test("resolves the http.get resource and grounds with the agent's SQL — end to end through the host", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
    const dbPath = join(cwd, "g.duckdb"); // persistent so the ETag memo survives across the two runs

    // exact-match projection tier — the agent's grounding SQL over the resolved candidate table
    const sql = "SELECT obo_id, label FROM ols4_candidates WHERE lower(label) = 'asthma'";
    // the AGENT supplies the query as a DuckDB session variable; the manifest's url is a SQL EXPRESSION that
    // composes it: '…?q=' || getvariable('query'). No bespoke template DSL, no hardcoded term.
    const first = await runBioQueryFromManifest({ cwd, dbPath, manifestPath: MANIFEST, sql, bindings: { query: "asthma" }, network: { fetch: ols4Mock("ols4-v1") }, runId: "g1", now: "T1" });

    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.match(lastUrl, /[?&]q=asthma&/, "getvariable('query') composed the URL via plain SQL");
    assert.match(lastUrl, /ontology=mondo/, "an unset param falls back via coalesce(getvariable('ontology'), 'mondo')");
    const result = JSON.parse(await fs.readFile(join(first.runDir, "result.json"), "utf8")) as { rows: Array<{ obo_id: string; label: string }> };
    assert.deepEqual(result.rows, [{ obo_id: "MONDO:0004979", label: "asthma" }]);

    // a DIFFERENT query/ontology composes a new URL from the SAME manifest, URL-ENCODED in pure SQL (url_encode)
    await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql, bindings: { query: "lung cancer", ontology: "hp" }, network: { fetch: ols4Mock("ols4-v2") }, runId: "g2", now: "T2" });
    assert.match(lastUrl, /[?&]q=lung%20cancer&ontology=hp&/, "url_encode(getvariable('query')) encoded the space — all in SQL");
  });

  test("fails closed when {query} has no binding (getvariable is NULL -> the url composes to non-http -> failed run)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT 1", network: { fetch: ols4Mock("x") }, runId: "g3", now: "T1" });
    assert.equal(out.ok, false); // a runtime resolution failure is an auditable failed run, not a silent empty result
    if (out.ok) return;
    assert.match(out.error, /not an http\(s\) URL/);
  });

  test("fails closed with NO network bound — a networked manifest cannot resolve without the host's opt-in", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
    // binding supplied; no network -> http.get unbound -> resolution fails closed
    await assert.rejects(
      () => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM ols4_candidates", bindings: { query: "asthma" }, runId: "g4", now: "T1" }),
      /http\.get' is declared but no implementation is bound/,
    );
  });
});
