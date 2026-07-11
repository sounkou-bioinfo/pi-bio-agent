import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioOperationFromManifest, runBioQueryFromManifest } from "../dist/hosts/run-store.js";

// PATTERN: "most of ClawBio for free" — a real variant-classification skill is a MANIFEST + SQL, not a .ts file.
// One manifest (examples/rare-high-impact: a variants table + the LoF SO-term set) answers MANY ClawBio-shaped
// questions with NO new code:
//   1. the PINNED, tested classification operation `rare_high_impact.report` — the safety-critical one, with
//      the abstention rule (unknown allele frequency is NOT counted as rare; benign LoF is excluded);
//   2. an AD-HOC exploratory cut over the same resolved tables (consequence breakdown) — the agent just writes
//      SQL, no operation needed.
// Both run through the real substrate runner (resolvers -> tables -> read-only SQL -> result + receipts).
//
// Run: npm run build && node scripts/variant-classification.mjs

const MANIFEST = resolve(process.cwd(), "examples", "rare-high-impact", "manifest.json");

async function rowsOf(out) {
  if (!out.ok) throw new Error(`run failed: ${out.error ?? "unknown"}`);
  const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8"));
  return result.rows;
}

async function main() {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-classify-"));
  console.log("=== ClawBio Variant Classification, for free: one manifest, many questions, all SQL ===\n");

  // 1. the PINNED tested operation — the defensible classification with abstention
  const op = await runBioOperationFromManifest({
    cwd, dbPath: ":memory:", manifestPath: MANIFEST, operationId: "rare_high_impact.report", runId: "classify", now: "T1",
  });
  const buckets = await rowsOf(op);
  console.log("### 1. PINNED operation `rare_high_impact.report` (tested, abstention-aware)");
  for (const r of buckets) console.log(`    ${String(r.bucket).padEnd(16)} ${r.n}`);
  const included = buckets.find((r) => r.bucket === "included")?.n ?? 0;
  const abstained = buckets.find((r) => r.bucket === "no_frequency")?.n ?? 0;
  console.log(`    -> defensible rare-high-impact count = ${included}; ABSTAINED on ${abstained} (unknown frequency, NOT called rare)`);
  console.log(`    receipts: ${join(op.runDir, "receipts.json")}\n`);

  // 2. an AD-HOC question over the SAME tables — no new operation, the agent just writes SQL
  const q = await runBioQueryFromManifest({
    cwd, dbPath: ":memory:", manifestPath: MANIFEST, runId: "explore", now: "T1",
    sql: "SELECT consequence, count(*) AS n, round(avg(allele_frequency), 5) AS avg_af FROM annotated_variants GROUP BY consequence ORDER BY n DESC, consequence",
  });
  console.log("### 2. AD-HOC cut over the same resolved tables (no operation, just SQL)");
  for (const r of await rowsOf(q)) console.log(`    ${String(r.consequence).padEnd(12)} n=${r.n}  avg_af=${r.avg_af ?? "NULL"}`);

  console.log("\nWhat it proves: the classification 'skill' is a tested SQL operation (not bespoke code), the");
  console.log("abstention is enforced in SQL, and the same declared data answers ad-hoc questions for free —");
  console.log("ClawBio's Variant Classification skill, reproduced as the substrate's data+SQL with provenance.");
}

main().catch((e) => { console.error(e); process.exit(1); });
