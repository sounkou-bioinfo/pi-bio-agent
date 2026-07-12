# Live survey and synthesis


Two independent Pi processes answer the same question. A third process
receives both notes and synthesizes them. The QMD owns the harness and
renders the current run; there is no separate hidden demo script.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runStudyScaffold } from "../../dist/core/study-exec.js";

const model = process.env.PI_BIO_AGENT_MODEL ?? "openai-codex/gpt-5.3-codex-spark";
const timeout = Number(process.env.PI_BIO_AGENT_TIMEOUT_MS ?? 120_000);
const processes = [];
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
    processes.push({ label, pid: child.pid });
    resolveRun(stdout.trim());
  });
});

const question = "Name the two most important quality checks before trusting a VCF for association analysis.";
const scaffold = {
  schema: "pi-bio.study_scaffold.v1",
  corpusId: "live-survey",
  objective: "independent answers followed by synthesis",
  steps: [
    { id: "respondent-a", subtask: question, produces: "worked_example", accessList: {} },
    { id: "respondent-b", subtask: question, produces: "worked_example", accessList: {} },
    { id: "synthesis", subtask: "Synthesize and deduplicate the two answers.", produces: "index", accessList: { notes: ["respondent-a", "respondent-b"] } },
  ],
};
const worker = async ({ step, notes }) => {
  const prompt = notes.length === 0
    ? `Answer independently and concisely: ${question}`
    : `${step.subtask}\n\n${notes.map((note) => `--- ${note.slug} ---\n${note.body}`).join("\n\n")}\n\nReply with only the synthesis.`;
  return { body: await runAgent(prompt, step.id), hook: `survey ${step.id}` };
};

const result = await runStudyScaffold(scaffold, worker, { now: new Date().toISOString() });
assert.equal(new Set(processes.map((process) => process.pid)).size, 3);
assert.deepEqual(result.notes.at(-1)?.links?.map((link) => link.to).sort(), ["respondent-a", "respondent-b"]);
piBio.json({ model, processes, order: result.order, notes: result.notes });
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
      "label": "respondent-a",
      "pid": 1305910
    },
    {
      "label": "respondent-b",
      "pid": 1306009
    },
    {
      "label": "synthesis",
      "pid": 1306092
    }
  ],
  "order": [
    "respondent-a",
    "respondent-b",
    "synthesis"
  ],
  "notes": [
    {
      "schema": "pi-bio.study_note.v1",
      "slug": "respondent-a",
      "id": "respondent-a@2026-07-12T14:26:00.677Z",
      "kind": "worked_example",
      "title": "respondent-a",
      "hook": "survey respondent-a",
      "body": "For association analysis, the two most important QC checks on a VCF are:\n\n1. **Variant and sample call quality/completeness**  \n   Filter low-quality calls (e.g., low `QUAL`, low `DP`, low genotype quality) and high missingness; remove poor variants/samples with excessive missing genotypes.\n\n2. **Hardy–Weinberg equilibrium (HWE) and population artifacts**  \n   Check variants for strong HWE deviations in controls (possible genotyping errors/contamination) and confirm ancestry/sample relatedness are not confounding the association results.",
      "tags": [],
      "links": [],
      "sources": [],
      "createdAt": "2026-07-12T14:26:00.677Z",
      "updatedAt": "2026-07-12T14:26:00.677Z"
    },
    {
      "schema": "pi-bio.study_note.v1",
      "slug": "respondent-b",
      "id": "respondent-b@2026-07-12T14:26:00.677Z",
      "kind": "worked_example",
      "title": "respondent-b",
      "hook": "survey respondent-b",
      "body": "1. **Variant-level quality**: Filter out low-confidence genotypes/variants (e.g., low QUAL/quality flags, low depth or genotype quality, high missingness, very low MAF, HWE violations in controls).  \n2. **Sample-level quality**: Exclude poor-quality samples (high missingness, abnormal heterozygosity, sex/ID mismatches, duplicates/contamination-related issues).",
      "tags": [],
      "links": [],
      "sources": [],
      "createdAt": "2026-07-12T14:26:00.677Z",
      "updatedAt": "2026-07-12T14:26:00.677Z"
    },
    {
      "schema": "pi-bio.study_note.v1",
      "slug": "synthesis",
      "id": "synthesis@2026-07-12T14:26:00.677Z",
      "kind": "index",
      "title": "synthesis",
      "hook": "survey synthesis",
      "body": "For association analysis, the key QC items are:\n\n1. **Variant-level QC:** exclude low-confidence variants/samples (low QUAL/DP/GQ, low call rate/high missingness, bad quality flags), and filter problematic variants such as very low MAF and strong HWE deviations in controls (plus other obvious genotype artefacts).\n\n2. **Sample-level QC:** remove poor-quality samples (high missingness, abnormal heterozygosity, sex/ID mismatches, duplicates/contamination), and check population/relatedness structure to avoid confounding (e.g., ancestry outliers, cryptic relatedness).",
      "tags": [],
      "links": [
        {
          "to": "respondent-a",
          "predicate": "depends_on"
        },
        {
          "to": "respondent-b",
          "predicate": "depends_on"
        }
      ],
      "sources": [],
      "createdAt": "2026-07-12T14:26:00.677Z",
      "updatedAt": "2026-07-12T14:26:00.677Z"
    }
  ]
}
```

</details>

This proves the host mechanics of independent fanout and bounded
synthesis. It is not a jury-calibration result, learned orchestration,
or evidence that three calls outperform one.
