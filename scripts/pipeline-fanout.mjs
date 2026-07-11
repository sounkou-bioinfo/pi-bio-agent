import { runPipeline } from "../dist/core/pipeline.js";

// PATTERN: the PIPELINE (nng push/pull) topology — a bounded work POOL. `runPipeline(tasks, worker, concurrency)`
// runs at most `concurrency` lanes pulling from a shared cursor, so N tasks drain through a fixed pool (results
// stay in task order). This is the shape of chunked, rate-limited annotation: split a whole VCF into batches and
// push them through a pool of <= K in-flight requests (the same role src/duckdb/ncurl-fanout.ts plays for the
// per-round ncurl_aio fanout). Here the "request" is a deterministic local classification of a variant chunk, so
// the run is reproducible and the concurrency CAP is checked, not asserted.
//
// Run: npm run build && node scripts/pipeline-fanout.mjs

const CONCURRENCY = 3;

// 9 chunks of variants to classify; each "chunk" is a list of allele frequencies + a high-impact flag.
const chunks = Array.from({ length: 9 }, (_, i) => ({
  id: `chunk-${i}`,
  variants: [{ af: i % 4 === 0 ? null : 0.0001 * (i + 1), hi: i % 2 === 0 }, { af: 0.2, hi: true }, { af: null, hi: false }],
}));

let inFlight = 0, maxInFlight = 0;
const order = [];

// The worker = one "request": classify a chunk (the same rare/high-impact + abstention rule as the SQL operation,
// here in JS so the pattern is network-free). It tracks how many lanes are live to prove the pool cap.
const worker = async (chunk, i) => {
  inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((r) => setTimeout(r, Math.max(10, 70 - i * 8))); // varied per-chunk "latency" (early = slower)
  const included = chunk.variants.filter((v) => v.hi && v.af !== null && v.af < 0.01).length;
  const abstained = chunk.variants.filter((v) => v.af === null).length;
  order.push(chunk.id);
  inFlight--;
  return { chunk: chunk.id, included, abstained };
};

console.log(`=== PIPELINE (push/pull) topology: ${chunks.length} chunks through a pool of ${CONCURRENCY} lanes ===\n`);
const t0 = Date.now();
const results = await runPipeline(chunks, worker, CONCURRENCY);
const ms = Date.now() - t0;

console.log("per-chunk results (returned IN TASK ORDER, regardless of completion order):");
for (const r of results) console.log(`  ${r.chunk.padEnd(9)} included=${r.included}  abstained=${r.abstained}`);

const totalIncluded = results.reduce((a, r) => a + r.included, 0);
const totalAbstained = results.reduce((a, r) => a + r.abstained, 0);
console.log(`\ntotals: included=${totalIncluded}  abstained=${totalAbstained}  (across ${chunks.length} chunks)`);
console.log(`max lanes ever in flight: ${maxInFlight}  (cap = ${CONCURRENCY})`);
console.log(`completion order (work-stealing, NOT task order): ${order.join(", ")}`);
console.log(`wall time: ${ms}ms  (serial would be ~${chunks.length * 25}ms; the pool overlaps them)`);

const capHeld = maxInFlight <= CONCURRENCY;
const orderedResults = results.every((r, i) => r.chunk === `chunk-${i}`);
console.log(`\ncap-respected invariant: ${capHeld ? "HELD" : "VIOLATED"}; results-in-task-order: ${orderedResults ? "HELD" : "VIOLATED"}`);
console.log("What it proves: 9 tasks drained through exactly 3 lanes (never more in flight), faster than serial,");
console.log("with results reassembled in task order though they completed out of order — push/pull work-pool, the");
console.log("topology a rate-limited whole-VCF annotation fanout uses (bound K in-flight requests, UNION results).");
if (!capHeld || !orderedResults) process.exit(1);
