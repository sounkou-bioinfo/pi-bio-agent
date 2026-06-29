import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// Honest tag: this reproduces a REAL named ClawBio skill — Variant Annotation ("Annotate VCF variants with
// Ensembl VEP REST, ClinVar significance, gnomAD frequencies", https://github.com/ClawBio/ClawBio). The bet
// made concrete for the ClawBio API half: that skill is just examples/variant-annotation/manifest.json + one
// SQL filter, no VEP/ClinVar/gnomAD code. Runs the REAL example manifest end-to-end through the host with an
// INJECTED mock fetch (no live network): http.get resource -> annotated table -> the agent's filter SQL.

// repo-root-anchored (npm test runs compiled code from dist-test/, so cwd is the repo root in both runners)
const MANIFEST = resolve(process.cwd(), "examples", "variant-annotation", "manifest.json");

// a VEP-REST-shaped response, flattened to the annotated rows the filter SQL consumes (gnomAD AF + ClinVar sig
// come from VEP's colocated_variants). The real VEP envelope is nested and unnested in SQL; the mock flattens.
const vepMock = (etag: string): FetchLike => async (_url, init) => {
  const h = { get: (n: string) => (n.toLowerCase() === "etag" ? etag : null) };
  if (init?.headers?.["If-None-Match"] === etag) return { ok: false, status: 304, text: async () => "", headers: h };
  const body = [
    { input: "rs699", gene_symbol: "AGT", most_severe_consequence: "missense_variant", gnomad_af: 0.42, clinvar_clin_sig: "benign" },
    { input: "var2", gene_symbol: "BRCA1", most_severe_consequence: "stop_gained", gnomad_af: 0.0001, clinvar_clin_sig: "pathogenic" },
    { input: "var3", gene_symbol: "CFTR", most_severe_consequence: "frameshift_variant", gnomad_af: 0.002, clinvar_clin_sig: "pathogenic" },
    { input: "var4", gene_symbol: "TP53", most_severe_consequence: "missense_variant", gnomad_af: 0.2, clinvar_clin_sig: "pathogenic" },
  ];
  return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: h };
};

const FILTER_SQL = [
  "SELECT input, gene_symbol, most_severe_consequence",
  "FROM vep_annotations",
  "WHERE gnomad_af < 0.01 AND clinvar_clin_sig = 'pathogenic'", // rare (gnomAD) + pathogenic (ClinVar)
  "ORDER BY gene_symbol",
].join("\n");

describe("example: a ClawBio Variant Annotation skill is a manifest, not code", () => {
  test("resolves the VEP http.get resource and filters rare+pathogenic with the agent's SQL — end to end", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
    const dbPath = join(cwd, "v.duckdb"); // persistent so the ETag memo survives across the two runs
    const first = await runBioQueryFromManifest({ cwd, dbPath, manifestPath: MANIFEST, sql: FILTER_SQL, network: { fetch: vepMock("vep-v1") }, runId: "v1", now: "T1" });

    assert.equal(first.ok, true);
    if (!first.ok) return;
    const result = JSON.parse(await fs.readFile(join(first.runDir, "result.json"), "utf8")) as { rows: Array<{ input: string; gene_symbol: string; most_severe_consequence: string }> };
    // rare(<0.01) AND pathogenic: BRCA1 stop_gained (0.0001) + CFTR frameshift (0.002); AGT benign and TP53 common are excluded
    assert.deepEqual(result.rows, [
      { input: "var2", gene_symbol: "BRCA1", most_severe_consequence: "stop_gained" },
      { input: "var3", gene_symbol: "CFTR", most_severe_consequence: "frameshift_variant" },
    ]);

    // re-annotating the same variants replays the ETag memo (304) — no re-download, same answer
    const second = await runBioQueryFromManifest({ cwd, dbPath, manifestPath: MANIFEST, sql: FILTER_SQL, network: { fetch: vepMock("vep-v1") }, runId: "v2", now: "T2" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const receipts = JSON.parse(await fs.readFile(join(second.runDir, "receipts.json"), "utf8")) as Array<{ sourceSnapshots?: Array<{ retrievedAt?: string }> }>;
    const vepReceipt = receipts.find((r) => r.sourceSnapshots?.[0]?.retrievedAt);
    assert.equal(vepReceipt?.sourceSnapshots?.[0]?.retrievedAt, "T1", "the 304 replays the cached resolution from run 1");
  });

  test("fails closed with NO network bound — the VEP manifest cannot resolve without the host's opt-in", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
    await assert.rejects(
      () => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM vep_annotations", runId: "v3", now: "T1" }),
      /http\.get' is declared but no implementation is bound/,
    );
  });
});
