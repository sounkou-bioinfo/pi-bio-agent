# Live access-list agent chain


Each study step launches a separate Pi process. The downstream agent
receives only the durable note allowed by its access list; no agent
opens a shared DuckDB file. This is a live host pattern, so model output
is not a deterministic fixture or a biomedical fact.

Set `PI_BIO_AGENT_MODEL` to choose a configured model. The default is
`openai-codex/gpt-5.3-codex-spark`.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runStudyScaffold } from "../../dist/core/study-exec.js";

const model = process.env.PI_BIO_AGENT_MODEL ?? "openai-codex/gpt-5.3-codex-spark";
const timeout = Number(process.env.PI_BIO_AGENT_TIMEOUT_MS ?? 120_000);
const calls = [];
const runAgent = (prompt, label) => new Promise((resolveRun, reject) => {
  const child = spawn("pi", [
    "--model", model, "--thinking", "medium", "--no-extensions", "--no-skills",
    "--no-context-files", "--no-session", "--no-tools", "-p", prompt,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (code !== 0) return reject(new Error(`pi ${label} exited ${String(code ?? signal)}: ${stderr.slice(-800)}`));
    calls.push({ label, pid: child.pid });
    resolveRun(stdout.trim());
  });
});

const scaffold = {
  schema: "pi-bio.study_scaffold.v1",
  corpusId: "live-demo",
  objective: "demonstrate an access-list agent chain",
  steps: [
    { id: "define-vcf", subtask: "Define a VCF file in two short sentences.", produces: "cheatsheet", accessList: {} },
    { id: "followups", subtask: "List exactly two follow-up questions about VCF quality.", produces: "question_bank", accessList: { notes: ["define-vcf"] } },
  ],
};
const worker = async ({ step, notes }) => {
  const upstream = notes.length
    ? `\n\nAllowed upstream notes:\n${notes.map((note) => `--- ${note.slug} ---\n${note.body}`).join("\n\n")}`
    : "\n\nNo upstream notes are available.";
  const body = await runAgent(
    `You are one worker in a study scaffold. ${step.subtask}${upstream}\nReply with only the concise note content.`,
    step.id,
  );
  return { body, hook: `produced by ${step.id}` };
};

const result = await runStudyScaffold(scaffold, worker, { now: new Date().toISOString() });
assert.deepEqual(result.order, ["define-vcf", "followups"]);
assert.equal(new Set(calls.map((call) => call.pid)).size, 2);
assert.deepEqual(result.notes[1].links?.map((link) => link.to), ["define-vcf"]);
piBio.json({ model, processes: calls, order: result.order, notes: result.notes });
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "model": "openai-codex/gpt-5.3-codex-spark",
  "processes": [
    {
      "label": "define-vcf",
      "pid": 1305491
    },
    {
      "label": "followups",
      "pid": 1305560
    }
  ],
  "order": [
    "define-vcf",
    "followups"
  ],
  "notes": [
    {
      "schema": "pi-bio.study_note.v1",
      "slug": "define-vcf",
      "id": "define-vcf@2026-07-12T14:25:39.668Z",
      "kind": "cheatsheet",
      "title": "define-vcf",
      "hook": "produced by define-vcf",
      "body": "A VCF (Variant Call Format) file is a text file used to list genetic variants such as SNPs and indels against a reference genome.  \nIt has a metadata header plus tab-delimited rows that record each variant’s chromosome position, alleles, quality metrics, and sample genotypes.",
      "tags": [],
      "links": [],
      "sources": [],
      "createdAt": "2026-07-12T14:25:39.668Z",
      "updatedAt": "2026-07-12T14:25:39.668Z"
    },
    {
      "schema": "pi-bio.study_note.v1",
      "slug": "followups",
      "id": "followups@2026-07-12T14:25:39.668Z",
      "kind": "question_bank",
      "title": "followups",
      "hook": "produced by followups",
      "body": "1. What minimum quality threshold (e.g., QUAL, QD, or GQ) will be used to classify a variant in this VCF as high confidence?  \n2. Which INFO/FILTER quality fields (such as DP, MQ, FS, or SOR) will you inspect to identify likely false-positive calls?",
      "tags": [],
      "links": [
        {
          "to": "define-vcf",
          "predicate": "depends_on"
        }
      ],
      "sources": [],
      "createdAt": "2026-07-12T14:25:39.668Z",
      "updatedAt": "2026-07-12T14:25:39.668Z"
    }
  ]
}
```

</details>

The assertions prove separate processes, access-list dependency, and
durable note shape. They do not prove that the model learned from the
interaction or that this chain is better than a single-agent baseline.
