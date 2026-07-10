import { spawn } from "node:child_process";
import { runStudyScaffold, type StudyWorker } from "../src/core/study-exec.js";
import type { StudyScaffold } from "../src/core/study.js";

// COORDINATOR: runs the scaffold executor, but its worker port dispatches each step over HTTP to a SEPARATE
// worker process (a different host:port = a different machine). The executor is UNCHANGED — only the worker
// implementation differs from the local-spawn one. Access-list artifacts travel in the HTTP request; large data
// would instead travel by CAS address on shared storage. Run: npx tsx scripts/multi-machine-run.ts

const fleet = [
  { label: "machine-1", port: 8071 },
  { label: "machine-2", port: 8072 },
];
const requestTimeoutMs = Number(process.env.PI_BIO_AGENT_TIMEOUT_MS ?? 120_000) + 5_000;

// start the worker nodes as separate OS processes (here on localhost ports; on a real fleet, real hosts)
const children = fleet.map((w) =>
  spawn("node", ["scripts/remote-worker.mjs", String(w.port), w.label], { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] }),
);
await new Promise((r) => setTimeout(r, 1500)); // let them bind

// placement policy: leaves -> machine-1, the synthesizer -> machine-2 (a trivial scheduler)
const route = (id: string) => (id === "followups" ? fleet[1]! : fleet[0]!);

const httpWorker: StudyWorker = async ({ step, notes }) => {
  const w = route(step.id);
  console.log(`coordinator: dispatch step '${step.id}'  ->  ${w.label} (http://localhost:${w.port}/run)`);
  const resp = await fetch(`http://localhost:${w.port}/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step, notes }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const j = (await resp.json()) as { body?: string; hook?: string; machine?: string; error?: string };
  if (!resp.ok || j.body === undefined || j.hook === undefined || j.machine === undefined) {
    throw new Error(`worker ${w.label} failed (${resp.status}): ${j.error ?? "invalid response"}`);
  }
  console.log(`coordinator: step '${step.id}' completed on ${j.machine}`);
  return { body: j.body, hook: j.hook };
};

const scaffold: StudyScaffold = {
  schema: "pi-bio.study_scaffold.v1", corpusId: "multi-machine", objective: "run agents across machines",
  steps: [
    { id: "define-vcf", subtask: "In two short sentences, define what a VCF file is in genomics.", produces: "cheatsheet", accessList: {} },
    { id: "followups", subtask: "Using the upstream definition, list exactly two concise follow-up questions a bioinformatician would ask.", produces: "question_bank", accessList: { notes: ["define-vcf"] } },
  ],
};

try {
  const result = await runStudyScaffold(scaffold, httpWorker, { now: new Date().toISOString() });
  console.log("\n===== RESULT (each step ran on a SEPARATE worker process, reached over HTTP) =====");
  for (const n of result.notes) console.log(`\n### ${n.slug}\n${n.body}`);
  console.log(`\norder: ${result.order.join(" -> ")}`);
} finally {
  for (const c of children) c.kill();
}
