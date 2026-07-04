// PRODUCTION runner for Phase 4.1: run the coloc manifest (DATA + COMPUTE -> per-tissue posteriors) and RECORD its
// judgment into the ONE bio_observations store as time-versioned KG facts. Every posterior lands as a scalar
// observation; the thresholded PP.H4 > t call lands as an edge (tissue -shares_causal_variant_with-> gwas_locus)
// that projects into bio_edges_as_of. The mapping lives ONCE in src/producers/coloc-record.ts (shared with the
// test); this file is the thin CLI that drives it against a real on-disk store.
//
//   npm run build && node examples/coloc/record.mjs            # store at .pi/bio-agent/store.duckdb
//   COLOC_LOCUS=gwas1 node examples/coloc/record.mjs           # override the locus id
//
// Skip-gated (like the test / example-readme generator): needs Rscript + the R `nanoarrow` package (the Arrow-IPC
// codec). Absent => prints a skip notice and exits 0, so it never breaks a no-R environment.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBioStore } from "../../dist/hosts/bio-store.js";
import { nodeComputeRunner } from "../../dist/process/node-compute-runner.js";
import { runColocRecord } from "../../dist/producers/coloc-record.js";
import { observationsAsOf, materializeBioEdgesAsOf } from "../../dist/duckdb/observations.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "manifest.json");
const locusId = process.env.COLOC_LOCUS ?? "gwas1";
const now = new Date().toISOString();

const rOk = (() => {
  try { execFileSync("Rscript", ["-e", 'if(!requireNamespace("nanoarrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" }); return true; } catch { return false; }
})();
if (!rOk) {
  console.log("skip: coloc record.mjs needs Rscript + the R 'nanoarrow' package (the Arrow-IPC codec) — not found.");
  process.exit(0);
}

const store = await openBioStore(process.cwd());
try {
  const res = await runColocRecord({
    cwd: here, manifestPath, store: store.conn, computeRunner: nodeComputeRunner(),
    locusId, runId: `coloc-record-${Date.now()}`, recordedAt: now,
  });
  if (!res.ok) { console.error(`coloc run failed: ${res.error}`); process.exit(1); }
  console.log(`recorded ${res.recorded} coloc posteriors for locus '${locusId}' (run ${res.runId}, digest ${res.resultDigest}).`);

  const asof = await observationsAsOf(store.conn, now);
  const posteriors = asof
    .filter((r) => r.predicate?.startsWith("coloc:posterior:") && r.statement_key.startsWith(`coloc:${locusId}:`))
    .map((r) => ({ tissue: r.subject_id.split(":").pop(), hypothesis: r.predicate.split(":").pop(), pp: JSON.parse(r.value_json ?? "null") }));
  console.log("scalar posteriors (as-of now):");
  for (const p of posteriors) console.log(`  ${p.tissue.padEnd(12)} ${p.hypothesis}  ${p.pp}`);

  await materializeBioEdgesAsOf(store.conn, now);
  const edges = await store.conn.all(
    "SELECT from_id, predicate, to_id FROM bio_edges_as_of WHERE predicate = 'coloc:shares_causal_variant_with' AND to_id = ?",
    [`gwas_locus:${locusId}`],
  );
  console.log(`biological call (PP.H4 > 0.8) recorded as ${edges.length} edge(s):`);
  for (const e of edges) console.log(`  ${e.from_id} -${e.predicate}-> ${e.to_id}`);
} finally {
  store.close();
}
