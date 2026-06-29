import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// The bet, made concrete: a ClawBio "ground a term against OLS4" skill is just examples/ols4-grounding/
// manifest.json + one SQL query — no OLS4-specific code. This runs that REAL example manifest end-to-end
// through the host with an INJECTED mock fetch (no live network), proving the API-skill collapses to DATA:
// http.get resource -> materialized candidate table -> grounding SQL the agent writes. Network is the host's
// opt-in (here the test passes one; the Pi extension gates it on PI_BIO_ENABLE_NETWORK=1).

// repo-root-anchored: npm test compiles to dist-test/ and runs from the repo root, so cwd is the repo root
// in both the compiled and the tsx runners (import.meta.dirname differs between them).
const MANIFEST = resolve(process.cwd(), "examples", "ols4-grounding", "manifest.json");

// an OLS4-search-shaped response, flattened to the candidate rows the grounding SQL consumes
const ols4Mock = (etag: string): FetchLike => async (_url, init) => {
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
    const first = await runBioQueryFromManifest({ cwd, dbPath, manifestPath: MANIFEST, sql, network: { fetch: ols4Mock("ols4-v1") }, runId: "g1", now: "T1" });

    assert.equal(first.ok, true);
    if (!first.ok) return;
    const result = JSON.parse(await fs.readFile(join(first.runDir, "result.json"), "utf8")) as { rows: Array<{ obo_id: string; label: string }> };
    assert.deepEqual(result.rows, [{ obo_id: "MONDO:0004979", label: "asthma" }]);

    // re-grounding the same endpoint replays the ETag memo (304) — no re-download, same answer
    const second = await runBioQueryFromManifest({ cwd, dbPath, manifestPath: MANIFEST, sql, network: { fetch: ols4Mock("ols4-v1") }, runId: "g2", now: "T2" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const receipts = JSON.parse(await fs.readFile(join(second.runDir, "receipts.json"), "utf8")) as Array<{ sourceSnapshots?: Array<{ retrievedAt?: string }> }>;
    const ols4Receipt = receipts.find((r) => r.sourceSnapshots?.[0]?.retrievedAt);
    assert.equal(ols4Receipt?.sourceSnapshots?.[0]?.retrievedAt, "T1", "the 304 replays the cached resolution from run 1");
  });

  test("fails closed with NO network bound — a networked manifest cannot resolve without the host's opt-in", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-ols4-"));
    // no network -> http.get is declared but unbound -> resolution fails closed (never silently returns empty)
    await assert.rejects(
      () => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM ols4_candidates", runId: "g3", now: "T1" }),
      /http\.get' is declared but no implementation is bound/,
    );
  });
});
