import { spawn } from "node:child_process";
import { runStudyScaffold, type StudyWorker } from "../src/core/study-exec.js";
import type { StudyScaffold } from "../src/core/study.js";

// LIVE multi-agent run (a pattern, NOT a unit test — non-deterministic, spawns real LLM agents). Each scaffold
// step spawns a SEPARATE `pi` process as its worker; workers communicate ONLY through access-list artifacts the
// host threads between them (upstream note bodies injected into the downstream prompt) — never by opening a
// shared DuckDB file, so the process-exclusive RW lock is never touched. This is the boundary-correct Fugu run.

function piAgent(prompt: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const model = process.env.PI_BIO_AGENT_MODEL ?? "openai-codex/gpt-5.3-codex";
    const timeout = Number(process.env.PI_BIO_AGENT_TIMEOUT_MS ?? 120_000);
    const args = ["--model", model, "--thinking", "medium", "--no-extensions", "--no-skills",
      "--no-context-files", "--no-session", "--no-tools", "-p", prompt];
    const child = spawn("pi", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout });
    console.log(`  [host] spawned pi process pid=${child.pid} for step '${label}'`);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code, signal) => (code === 0
      ? resolve(out.trim())
      : reject(new Error(`pi exit ${code ?? signal} (${label}): ${err.slice(0, 400)}`))));
  });
}

const worker: StudyWorker = async ({ step, notes }) => {
  const ctx = notes.length
    ? `\n\nUpstream notes (the ONLY context you were given — access-list isolation):\n${notes.map((n) => `--- ${n.slug} ---\n${n.body}`).join("\n\n")}`
    : "\n\n(You are a root step: no upstream context.)";
  const prompt = `You are one worker in a multi-agent study scaffold. Your task: ${step.subtask}${ctx}\n\nReply with ONLY the resulting note content, concise (no preamble, no markdown headers).`;
  const body = await piAgent(prompt, step.id);
  return { body, hook: `study note produced by step ${step.id}` };
};

const scaffold: StudyScaffold = {
  schema: "pi-bio.study_scaffold.v1",
  corpusId: "live-demo",
  objective: "demonstrate a real multi-agent scaffold run",
  steps: [
    { id: "define-vcf", subtask: "In two short sentences, define what a VCF file is in genomics.", produces: "cheatsheet", accessList: {} },
    { id: "followups", subtask: "Using the upstream definition, list exactly two concise follow-up questions a bioinformatician would ask about VCF files.", produces: "question_bank", accessList: { notes: ["define-vcf"] } },
  ],
};

console.log("=== LIVE multi-agent scaffold run: each step = a separate pi process; comms via access-list artifacts ===");
const result = await runStudyScaffold(scaffold, worker, { now: new Date().toISOString() });
console.log("\n===== RESULT (each note produced by a DISTINCT pi process; 'followups' consumed 'define-vcf') =====");
for (const n of result.notes) {
  console.log(`\n### ${n.slug}  (depends_on: ${n.links?.map((l) => l.to).join(", ") || "none"})`);
  console.log(n.body);
}
console.log(`\nexecution order: ${result.order.join(" -> ")}`);
