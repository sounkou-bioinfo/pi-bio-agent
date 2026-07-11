import { memoryBlackboard, runScaffoldOnBlackboard } from "../dist/core/blackboard.js";

// PATTERN: the BLACKBOARD (nng pub/sub) topology — DECENTRALIZED, no coordinator. Every step is launched at the
// SAME time (runScaffoldOnBlackboard does Promise.all over all steps); a step that names upstream notes in its
// access list BLOCKS on `awaitNote(slug)` until those are published, then runs and publishes its own. So the
// execution order is NOT computed by a scheduler — it EMERGES from the data dependencies (publish = post to the
// board, await = subscribe). Same StudyWorker contract as the chain/survey patterns; only the topology differs.
// Deterministic (canned workers, no LLM) so it is reproducible and the emergence is observable.
//
// Run: npm run build && node scripts/blackboard-run.mjs

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(3, "0")}ms`;
const publishLog = [];

// A diamond DAG: extract -> {annotate, qc} -> classify. annotate/qc are independent (can publish in either
// order); classify must wait for BOTH. No code anywhere computes this order — it falls out of the access lists.
const scaffold = {
  schema: "pi-bio.study_scaffold.v1", corpusId: "variant-board", objective: "classify variants on a blackboard",
  steps: [
    { id: "extract",  subtask: "extract variant rows",            produces: "corpus_map",   accessList: {} },
    { id: "annotate", subtask: "annotate consequence",            produces: "cheatsheet",    accessList: { notes: ["extract"] } },
    { id: "qc",       subtask: "qc / frequency sanity",           produces: "concept_map",   accessList: { notes: ["extract"] } },
    { id: "classify", subtask: "classify from annotate + qc",     produces: "index",         accessList: { notes: ["annotate", "qc"] } },
  ],
};

// A canned, deterministic worker: it sees ONLY its access-list upstream notes (the isolation boundary), waits a
// per-step beat so the emergence is visible, then publishes a body that cites its inputs.
const delays = { extract: 20, annotate: 40, qc: 25, classify: 10 };
const worker = async ({ step, notes }) => {
  await new Promise((r) => setTimeout(r, delays[step.id] ?? 10));
  const cites = notes.length ? ` <- [${notes.map((n) => n.slug).join(", ")}]` : "";
  publishLog.push(`${stamp()}  ${step.id} publishes${cites}`);
  return { body: `${step.id}(${notes.map((n) => n.slug).join("+") || "root"})`, hook: step.subtask };
};

console.log("=== BLACKBOARD (pub/sub) topology: all steps launched at once; order EMERGES from data deps ===\n");
const notes = await runScaffoldOnBlackboard(scaffold, worker, memoryBlackboard(), { now: "T1" });

console.log("publish order (as it happened on the board):");
for (const line of publishLog) console.log("  " + line);
console.log("\nfinal notes (by id):");
for (const n of notes) console.log(`  ${n.slug.padEnd(10)} body=${n.body}`);

const order = publishLog.map((l) => l.split(/\s+/)[1]);
const ok = order.indexOf("extract") < order.indexOf("annotate")
  && order.indexOf("extract") < order.indexOf("qc")
  && order.indexOf("classify") === order.length - 1;
console.log(`\nemergent-order invariant (extract first, classify last, no scheduler): ${ok ? "HELD" : "VIOLATED"}`);
console.log("What it proves: extract published first because both annotate+qc blocked on it; classify published");
console.log("LAST because it blocked on BOTH annotate and qc — yet nothing computed a topological order. The");
console.log("order is a CONSEQUENCE of the access lists (publish/subscribe), i.e. stigmergic coordination.");
if (!ok) process.exit(1);
