import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// SQL-native variant annotation (SAME SHAPE as the ClawBio Variant Annotation skill — "Annotate VCF variants
// with Ensembl VEP REST, ClinVar significance, gnomAD frequencies", https://github.com/ClawBio/ClawBio — NOT a
// faithful reproduction), DETERMINISTIC. The manifest POSTs VEP's batch endpoint with `ducknng_ncurl_table`
// (the body composed in SQL from the {vep_ids} JSON-array binding — a scalar, no TS resolver); ducknng parses
// the NESTED VEP envelope (transcript_consequences[] + colocated_variants[]) into STRUCT(...)[] columns the
// agent UNNESTs. A LOCAL ducknng server is the fixture: its POST route VALIDATES the {ids} body server-side
// (returns 400 -> ncurl_table requires 2xx -> the run fails, if no ids body) and then returns a canned nested
// envelope. No external network, no mock fetch.
const MANIFEST = resolve(process.cwd(), "examples", "variant-annotation", "manifest.json");
const PROVISION = ["INSTALL ducknng FROM community", "LOAD ducknng"];

const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

// A VEP-REST-shaped batch response: an array, one object per input variant, with the two nested arrays VEP
// returns. gnomAD AF + ClinVar clin_sig under colocated_variants; gene/impact under transcript_consequences.
// (Simplified: real VEP nests gnomAD AF under colocated_variants[].frequencies.<allele>; flattened to a single
// `gnomad_af` so the example stays about the unnest+filter pattern, not VEP frequency-map wrangling.)
const VEP_BODY = [
  { input: "rs699", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "AGT", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "rs699", clin_sig: ["benign"], gnomad_af: 0.42 }] },
  { input: "var2", most_severe_consequence: "stop_gained", transcript_consequences: [{ gene_symbol: "BRCA1", impact: "HIGH", consequence_terms: ["stop_gained"] }], colocated_variants: [{ id: "var2", clin_sig: ["pathogenic"], gnomad_af: 0.0001 }] },
  { input: "var3", most_severe_consequence: "frameshift_variant", transcript_consequences: [{ gene_symbol: "CFTR", impact: "HIGH", consequence_terms: ["frameshift_variant"] }], colocated_variants: [{ id: "var3", clin_sig: ["pathogenic"], gnomad_af: 0.002 }] },
  { input: "var4", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "TP53", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "var4", clin_sig: ["pathogenic"], gnomad_af: 0.2 }] },
  { input: "var5", most_severe_consequence: "missense_variant", transcript_consequences: [{ gene_symbol: "PALB2", impact: "MODERATE", consequence_terms: ["missense_variant"] }], colocated_variants: [{ id: "var5", clin_sig: ["pathogenic"], gnomad_af: 0.001 }] },
];

// the local ducknng server fixture. The POST route reads ducknng_http_request_body() and returns the canned
// envelope ONLY when the body carries an `ids` array (else 400) — so the test proves the manifest genuinely
// POSTs an { ids: [...] } batch body, server-side, the deterministic equivalent of inspecting init.body.
// Bind port 0 (OS-assigned) and DISCOVER the real base URL — a fixed port races under parallel test runs / TIME_WAIT.
async function startFixture(): Promise<{ base: string; close(): void }> {
  const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
  const fix = duckdbNodeConn(await inst.connect());
  await fix.run("LOAD ducknng");
  await fix.run(`SELECT ducknng_start_server('vep_fix', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
  const base = (await fix.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='vep_fix'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
  const canned = JSON.stringify(VEP_BODY).replaceAll("'", "''");
  await fix.run(
    `SELECT ducknng_register_http_route('vep_fix', 'POST', '/vep/human/id', ` +
    `'SELECT * FROM ducknng_http_json(` +
    `  CASE WHEN json_valid((SELECT body_text FROM ducknng_http_request_body())) ` +
    `       AND coalesce(json_array_length((SELECT body_text FROM ducknng_http_request_body()), ''$.ids''), 0) > 0 ` +
    `       THEN 200 ELSE 400 END, ` +  // require a non-empty ids array (real VEP 400s on null/empty ids)
    `  ''${canned}'')')`,
  );
  return { base, close: () => inst.closeSync() };
}

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

describe("example: batched VEP-shaped annotation through declared DuckNNG HTTP and SQL", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community on a matching DuckDB)" }, () => {
  test("POSTs a BATCH of ids via ncurl_table, ducknng parses the nested envelope, SQL unnests + filters rare+high-impact+pathogenic", async () => {
    const fixture = await startFixture();
    try {
      const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
      const out = await runBioQueryFromManifest({
        cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: FILTER_SQL,
        duckdbInitSql: PROVISION, duckdbConfig: { allow_unsigned_extensions: "true" },
        // the agent supplies the batch as a JSON-array string; base -> local fixture. The manifest does NOT
        // hardcode the ids — they are the agent's discovered batch. The route 400s if the body has no `ids`.
        bindings: { vep_base: fixture.base, vep_ids: JSON.stringify(["rs699", "var2", "var3", "var4", "var5"]) },
        runId: "v1", now: "T1",
      });
      assert.equal(out.ok, true);
      if (!out.ok) return;
      const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ input: string; gene_symbol: string; most_severe_consequence: string }> };
      // BRCA1 stop_gained + CFTR frameshift pass all three. Exclusions prove each predicate is load-bearing:
      //   AGT  -> benign (clin_sig) AND common; TP53 -> common (gnomad_af 0.2); PALB2 -> rare+pathogenic but
      //   MODERATE impact, excluded ONLY by the high-impact predicate.
      assert.deepEqual(result.rows, [
        { input: "var2", gene_symbol: "BRCA1", most_severe_consequence: "stop_gained" },
        { input: "var3", gene_symbol: "CFTR", most_severe_consequence: "frameshift_variant" },
      ]);
    } finally { fixture.close(); }
  });

  test("fails closed when {vep_ids} has no binding (json(NULL) -> the POST body has no ids -> route 400s -> auditable failed run)", async () => {
    const fixture = await startFixture();
    try {
      const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-vep-"));
      const out = await runBioQueryFromManifest({
        cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM vep_annotations",
        duckdbInitSql: PROVISION, duckdbConfig: { allow_unsigned_extensions: "true" },
        bindings: { vep_base: fixture.base }, // no vep_ids -> body lacks ids -> 400
        runId: "v2", now: "T1",
      });
      assert.equal(out.ok, false);
    } finally { fixture.close(); }
  });
});
