import { spawn } from "node:child_process";
import { runStudyScaffold, type StudyWorker } from "../src/core/study-exec.js";
import type { StudyScaffold } from "../src/core/study.js";

// LIVE survey/debate topology (Fugu's signature best-of-N): two respondent agents answer the SAME question
// INDEPENDENTLY (isolated from each other), then an aggregator agent synthesizes both. Same proven executor +
// direct-spawn worker as scripts/live-multi-agent.ts — only the scaffold TOPOLOGY changes (fan-in, not a chain).
// This is the survey/respondent nng pattern realized over the access-list DAG.

function piAgent(prompt: string, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", ["--provider", "openai-codex", "--model", "gpt-5.5", "--thinking", "low",
      "-e", "extensions/pi-coding-agent/index.ts", "-t", "read,grep,find,ls", "-p", prompt], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    console.log(`  [host] spawned pi pid=${child.pid} for '${label}'`);
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`pi ${code} (${label}): ${err.slice(0, 300)}`))));
  });
}

const QUESTION = "What are the two most important quality-control checks to run before trusting a VCF for downstream association analysis? Answer concisely.";

const worker: StudyWorker = async ({ step, notes }) => {
  const isAggregator = notes.length > 0;
  const prompt = isAggregator
    ? `You are the AGGREGATOR in a debate. Two agents independently answered this question:\n"${QUESTION}"\n\n${notes.map((n) => `--- ${n.slug}'s answer ---\n${n.body}`).join("\n\n")}\n\nSynthesize the single best concise answer, reconciling and de-duplicating. Reply with ONLY the synthesized answer.`
    : `You are a respondent. Answer this question independently and concisely:\n"${QUESTION}"\nReply with ONLY your answer.`;
  return { body: await piAgent(prompt, step.id), hook: `debate ${step.id}` };
};

const scaffold: StudyScaffold = {
  schema: "pi-bio.study_scaffold.v1", corpusId: "debate", objective: "best-of-N debate",
  steps: [
    { id: "respondent-a", subtask: "answer independently", produces: "worked_example", accessList: {} },
    { id: "respondent-b", subtask: "answer independently", produces: "worked_example", accessList: {} },
    { id: "aggregator", subtask: "synthesize the two answers", produces: "index", accessList: { notes: ["respondent-a", "respondent-b"] } },
  ],
};

console.log("=== LIVE debate (survey topology): 2 independent respondents + 1 aggregator, all real pi agents ===");
const result = await runStudyScaffold(scaffold, worker, { now: new Date().toISOString() });
for (const n of result.notes) console.log(`\n### ${n.slug} ${n.links?.length ? `(synthesizes: ${n.links.map((l) => l.to).join(", ")})` : "(independent)"}\n${n.body}`);
console.log(`\norder: ${result.order.join(" -> ")}`);
