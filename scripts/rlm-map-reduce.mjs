// RUNNABLE demo: the RLM MAP-REDUCE *shape* across PROCESSES — not a flat GROUP BY over pre-labeled rows. This is
// NOT a full RLM and does not measure one: no LM, no recursion, no unbounded context. It shows the STRUCTURE with a
// deterministic SQL stand-in for the semantic map, so it is testable.
// RLM (arXiv 2512.24601) recurses an LM over partitions of an unbounded context. The genuinely hard part is the
// SEMANTIC MAP: each row arrives UNLABELED (free text), and a worker INFERS its label (a judgment-boundary — an LM
// live; a deterministic SQL rule here). The distributional answer is only the REDUCE, after labels exist.
//
// This is the map-reduce-labeling shape (test/map-reduce-labeling.test.ts) made runnable and multi-process:
//   SUPERVISOR splits the context into partitions -> fans out to WORKER PROCESSES, each with its OWN :memory:
//   DuckDB SQL REPL that labels its partition and returns artifacts on stdout (workers NEVER touch shared state) ->
//   the HOST is the SINGLE WRITER that merges the label artifacts -> the distributional query is a deterministic
//   GROUP BY over the inferred labels. So the map is the recursion RLM pays for; the reduce is the distributional
//   count that a flat long-context pass degrades on (the RLM paper's motivation) and a GROUP BY computes exactly.
//   Run: `npm run build && node scripts/rlm-map-reduce.mjs`
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const WORKERS = 3;

// an UNLABELED long context (OOLONG-style free-text instances). No row carries its class — that is the point.
const CONTEXT = [
  "How many moons orbit Mars", "Who painted the ceiling", "Where is the capital city", "Define a covalent bond",
  "How old is the universe", "Who invented calypso", "Where is the river", "What planet is red",
  "How many years in a decade", "Who wrote the play", "Define entropy", "Where do salmon spawn",
].map((instance, i) => ({ id: i + 1, instance }));

// WORKER = one partition through its OWN SQL REPL. It loads its rows into a private :memory: DuckDB and labels them
// with SQL (regexp CASE) — the semantic map, done in the REPL RLM would recurse in. It writes NO shared state; it
// prints label artifacts as JSON. (Live, the CASE would be a sub-agent/LM call; deterministic here so it is testable.)
async function worker(part) {
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("CREATE TABLE part(id INTEGER, instance VARCHAR)");
  for (const r of part) await c.run("INSERT INTO part VALUES (?, ?)", [r.id, r.instance]);
  const reader = await c.runAndReadAll(`
    SELECT id, CASE
      WHEN lower(instance) LIKE '%how many%' OR lower(instance) LIKE '%how old%' THEN 'number'
      WHEN lower(instance) LIKE '%who%'    THEN 'human'
      WHEN lower(instance) LIKE '%where%'  THEN 'location'
      WHEN lower(instance) LIKE '%define%' THEN 'description'
      ELSE 'entity' END AS label
    FROM part ORDER BY id`);
  const labels = reader.getRowObjects().map((r) => ({ id: Number(r.id), label: String(r.label) }));
  c.closeSync(); inst.closeSync();
  return labels;
}

const spawnWorker = (part) => new Promise((res, rej) => {
  const ch = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker"], { stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  ch.stdout.on("data", (d) => (out += d));
  ch.on("close", (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`worker exit ${code}`))));
  ch.stdin.end(JSON.stringify(part)); // partition delivered on stdin — the worker is isolated to its slice
});

if (process.argv[2] === "worker") {
  const part = JSON.parse(await new Promise((r) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => r(s)); }));
  process.stdout.write(JSON.stringify(await worker(part)));
} else {
  console.log(`=== RLM as map-reduce: SUPERVISOR splits ${CONTEXT.length} unlabeled rows over ${WORKERS} worker processes ===\n`);
  // SUPERVISOR: partition the context into contiguous slices, one per worker process.
  const size = Math.ceil(CONTEXT.length / WORKERS);
  const partitions = Array.from({ length: WORKERS }, (_, k) => CONTEXT.slice(k * size, (k + 1) * size)).filter((p) => p.length);
  // MAP: fan out — each partition labeled in its OWN process + OWN SQL REPL, concurrently. Workers return artifacts only.
  const artifacts = (await Promise.all(partitions.map(async (p, k) => {
    const labels = await spawnWorker(p);
    console.log(`  [worker ${k}] labeled ids ${p.map((r) => r.id).join(",")} in its own SQL REPL (no shared write)`);
    return labels;
  }))).flat();

  // REDUCE: the HOST is the SINGLE WRITER — it merges the workers' label artifacts, then the distributional query is
  // a deterministic GROUP BY over the INFERRED labels. No worker ever wrote the store (no process-exclusive contention).
  const inst = await DuckDBInstance.create(":memory:");
  const c = await inst.connect();
  await c.run("CREATE TABLE ctx(id INTEGER, instance VARCHAR)");
  for (const r of CONTEXT) await c.run("INSERT INTO ctx VALUES (?, ?)", [r.id, r.instance]);
  await c.run("CREATE TABLE labels(id INTEGER, label VARCHAR)");
  for (const a of artifacts) await c.run("INSERT INTO labels VALUES (?, ?)", [a.id, a.label]); // host merges — single writer
  const agg = (await c.runAndReadAll("SELECT label, count(*) AS n FROM ctx JOIN labels USING (id) GROUP BY label ORDER BY label")).getRowObjects();
  c.closeSync(); inst.closeSync();

  const counts = Object.fromEntries(agg.map((r) => [r.label, Number(r.n)]));
  console.log("\n  REDUCE (deterministic GROUP BY over the inferred labels):", JSON.stringify(counts));
  const expected = { description: 2, human: 3, location: 3, number: 3, entity: 1 };
  const ok = JSON.stringify(Object.fromEntries(Object.entries(counts).sort())) === JSON.stringify(Object.fromEntries(Object.entries(expected).sort()));
  if (!ok) { console.error("FAIL: aggregate mismatch", { counts, expected }); process.exit(1); }
  console.log("\nSHOWN: the (deterministic stand-in) semantic MAP ran per-partition in separate worker processes (each");
  console.log("its own SQL REPL); the HOST single-writer merged the label artifacts; the distributional answer is an exact");
  console.log("GROUP BY. The flat GROUP BY is only the REDUCE half; this demo shows the MAP STRUCTURE it elides — no LM,");
  console.log("no recursion, no unbounded context (that is the shape RLM fills, not an RLM measurement).");
}
