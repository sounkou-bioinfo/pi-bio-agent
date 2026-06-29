import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// Honest tag: this is the SAME SHAPE as a real, named ClawBio skill — Variant Annotation ("Annotate VCF
// variants with Ensembl VEP REST, ClinVar significance, gnomAD frequencies", https://github.com/ClawBio/ClawBio)
// — NOT a faithful reproduction (it annotates one variant by id, not a whole VCF). The bet it proves for the
// ClawBio API half: that skill's shape is just a manifest + filter SQL, no VEP/ClinVar/gnomAD code. Runs the
// REAL example manifest end-to-end through the host with an INJECTED mock fetch (no live network) that returns
// a realistic NESTED VEP envelope (transcript_consequences + colocated_variants); the agent's SQL unnests it
// and filters rare + high-impact + pathogenic.

// repo-root-anchored (npm test runs compiled code from dist-test/, so cwd is the repo root in both runners)
const MANIFEST = resolve(process.cwd(), "examples", "variant-annotation", "manifest.json");

// A VEP-REST-shaped response: an array, one object per input variant, with the two nested arrays VEP actually
// returns. gnomAD AF + ClinVar clin_sig live under colocated_variants; gene/impact under transcript_consequences.
// (Simplified: real VEP nests gnomAD AF under colocated_variants[].frequencies.<allele>; flattened to one
// `gnomad_af` here so the example stays about the unnest+filter pattern, not VEP frequency-map wrangling.)
// the batch VEP response — honest now: the manifest POSTs many ids, so returning many annotations matches what
// the real /vep/human/id batch endpoint returns. The mock REQUIRES a POST with an `ids` body (proves the batch
// path is exercised, not a single-variant GET faked into many).
let lastRequest: { method?: string; body?: string } = {};
const vepMock = (): FetchLike => async (_url, init) => {
  lastRequest = { method: init?.method, body: init?.body };
  if (init?.method !== "POST" || !init.body || !JSON.parse(init.body).ids) throw new Error("VEP batch expects a POST with an { ids } body");
  const body = [
    { input: "rs699", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "AGT", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "rs699", clin_sig: ["benign"], gnomad_af: 0.42 }] },
    { input: "var2", most_severe_consequence: "stop_gained", transcript_consequences: [{ gene_symbol: "BRCA1", impact: "HIGH", consequence_terms: ["stop_gained"] }], colocated_variants: [{ id: "var2", clin_sig: ["pathogenic"], gnomad_af: 0.0001 }] },
    { input: "var3", most_severe_consequence: "frameshift_variant", transcript_consequences: [{ gene_symbol: "CFTR", impact: "HIGH", consequence_terms: ["frameshift_variant"] }], colocated_variants: [{ id: "var3", clin_sig: ["pathogenic"], gnomad_af: 0.002 }] },
    { input: "var4", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "TP53", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "var4", clin_sig: ["pathogenic"], gnomad_af: 0.2 }] },
    { input: "var5", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "PALB2", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "var5", clin_sig: ["pathogenic"], gnomad_af: 0.001 }] },
  ];
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }; // POST: no ETag memo, no headers needed
};

// The agent's SQL: unnest VEP's nested arrays, then filter rare (gnomAD) + high-impact (VEP impact) + pathogenic
// (ClinVar). All three predicates are load-bearing — see the exclusions asserted below.
const FILTER_SQL = [
  "WITH exploded AS (",
  "  SELECT input, most_severe_consequence,",
  "         UNNEST(transcript_consequences) AS tc,",
  "         UNNEST(colocated_variants) AS cv",
  "  FROM vep_annotations",
  ")",
  "SELECT input, tc.gene_symbol AS gene_symbol, most_severe_consequence",
  "FROM exploded",
  "WHERE cv.gnomad_af < 0.01",          // rare (gnomAD frequency)
  "  AND tc.impact = 'HIGH'",           // high-impact (VEP impact)
  "  AND list_contains(cv.clin_sig, 'pathogenic')", // pathogenic (ClinVar significance)
  "ORDER BY gene_symbol",
].join("\n");

describe("example: a ClawBio Variant Annotation-shaped skill is a manifest, not code", () => {
  test("POSTs a BATCH of variant ids, unnests the nested envelope, filters rare+high-impact+pathogenic across the batch", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: FILTER_SQL, network: { fetch: vepMock() }, runId: "v1", now: "T1" });

    assert.equal(out.ok, true);
    if (!out.ok) return;
    // the manifest genuinely POSTs a BATCH (proving it annotates many, not one variant faked into many)
    assert.equal(lastRequest.method, "POST");
    assert.deepEqual(JSON.parse(lastRequest.body!).ids.length, 5);

    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ input: string; gene_symbol: string; most_severe_consequence: string }> };
    // BRCA1 stop_gained + CFTR frameshift pass all three. Exclusions prove each predicate is load-bearing:
    //   AGT  -> benign (clin_sig) AND common; TP53 -> common (gnomad_af 0.2); PALB2 -> rare+pathogenic but
    //   MODERATE impact, excluded ONLY by the high-impact predicate.
    assert.deepEqual(result.rows, [
      { input: "var2", gene_symbol: "BRCA1", most_severe_consequence: "stop_gained" },
      { input: "var3", gene_symbol: "CFTR", most_severe_consequence: "frameshift_variant" },
    ]);
  });

  test("fails closed with NO network bound — the VEP manifest cannot resolve without the host's opt-in", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
    await assert.rejects(
      () => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM vep_annotations", runId: "v3", now: "T1" }),
      /http\.get' is declared but no implementation is bound/,
    );
  });
});
