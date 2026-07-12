# Typed memory across real Pi agents


# Agent-authored relations, ledger-backed

This live pattern starts two separate Pi processes against one project.
The writer has only `bio_remember`; the reader has only recall and graph
tools. Neither receives a skill, repository context, or a bespoke
prompt-side memory format. The Quarto document is the executable
harness, while `bio_observations` remains the evidence store.

Run from the repository root with `npm run pattern:typed-memory-agent`.
It requires a configured Pi provider; set `PI_BIO_PATTERN_MODEL` to
override the default `gpt-5.3-codex-spark` model.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { materializeBioEdgesAsOf } from "../../dist/duckdb/observations.js";
import { MEMORY_NOW, memoryHistory, memorySubjectId, recall } from "../../dist/hosts/memory-store.js";
import { sessionToolTrajectory } from "../../dist/hosts/session-ingest.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sourceDir, "../..");
const extensionPath = join(repoRoot, "extensions", "pi-coding-agent", "index.ts");
const projectDir = await mkdtemp(join(tmpdir(), "pi-bio-typed-memory-"));
const model = process.env.PI_BIO_PATTERN_MODEL ?? "gpt-5.3-codex-spark";
const providerArgs = model.includes("/") ? ["--model", model] : ["--provider", "openai-codex", "--model", model];

const runPi = (sessionId: string, tools: string[], prompt: string): Promise<string> => new Promise((resolveRun, reject) => {
  const child = spawn("pi", [
    ...providerArgs,
    "--thinking", "medium",
    "--extension", extensionPath,
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--session-id", sessionId,
    "--name", sessionId,
    "--tools", tools.join(","),
    "-p", prompt,
  ], { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code, signal) => code === 0
    ? resolveRun(stdout.trim())
    : reject(new Error(`pi ${sessionId} exited ${String(code ?? signal)}: ${stderr.slice(-1000)}`)));
});
```

``` ts
const writerSession = "typed-memory-writer";
const writer = await runPi(writerSession, ["bio_remember"], [
  "Use bio_remember exactly four times with the exact argument objects below, in order, and no other tools.",
  '1. {"slug":"source-schema","kind":"cheatsheet","title":"Source schema","hook":"Read before planning an analysis.","body":"Inspect declared columns before composing SQL."}',
  '2. {"slug":"review-checklist","kind":"rubric","title":"Review checklist","hook":"Read before accepting an analysis plan.","body":"Check declarations, query shape, receipts, and abstentions."}',
  '3. {"slug":"analysis-plan","kind":"concept_map","title":"Analysis plan","hook":"Read when resuming the analysis.","body":"Initial plan revision.","links":[{"to":"Source Schema"},{"to":"review-checklist","predicate":"see_also"}]}',
  '4. {"slug":"analysis-plan","kind":"concept_map","title":"Analysis plan","hook":"Read when resuming the analysis.","body":"Final plan: inspect schema, compose SQL, then review evidence.","links":[{"to":"source-schema","predicate":"depends_on"},{"to":"review-checklist","predicate":"see_also"}]}',
  "Finish with one short sentence saying the revision was recorded.",
].join("\n"));

const readerSession = "typed-memory-reader";
const reader = await runPi(readerSession, ["bio_recall", "bio_walk_memory", "bio_graph_window"], [
  "Use exactly three tools, in this order, and no others.",
  "1. bio_recall slug analysis-plan.",
  "2. bio_walk_memory from analysis-plan at depth 1.",
  "3. bio_graph_window from memory:analysis-plan, direction out, limit 10.",
  "Finish with one short sentence naming the two current predicates from analysis-plan.",
].join("\n"));
```

``` ts
const dbPath = join(projectDir, ".pi", "bio-agent", "store.duckdb");
const instance = await DuckDBInstance.create(dbPath);
const conn = duckdbNodeConn(await instance.connect());
try {
  const history = await memoryHistory(conn, "analysis-plan");
  const current = await recall(conn, "analysis-plan");
  await materializeBioEdgesAsOf(conn, MEMORY_NOW);
  const edges = await conn.all<{ predicate: string; to_id: string }>(
    "SELECT predicate, to_id FROM bio_edges_as_of WHERE from_id = ? ORDER BY predicate, to_id",
    [memorySubjectId("analysis-plan")],
  );
  const writerTools = await sessionToolTrajectory(conn, writerSession);
  const readerTools = await sessionToolTrajectory(conn, readerSession);

  assert.equal(history.length, 2);
  assert.deepEqual(history[0]?.content?.links, [
    { to: "source-schema", predicate: "references" },
    { to: "review-checklist", predicate: "see_also" },
  ]);
  assert.deepEqual(current?.links, [
    { to: "source-schema", predicate: "depends_on" },
    { to: "review-checklist", predicate: "see_also" },
  ]);
  assert.deepEqual(edges, [
    { predicate: "depends_on", to_id: "memory:source-schema" },
    { predicate: "see_also", to_id: "memory:review-checklist" },
  ]);
  assert.deepEqual(writerTools.map((tool) => tool.name), Array(4).fill("bio_remember"));
  assert.deepEqual(readerTools.map((tool) => tool.name), ["bio_recall", "bio_walk_memory", "bio_graph_window"]);

  piBio.json({
    model,
    agents: [
      { session: writerSession, tools: writerTools.map((tool) => tool.name), final: writer },
      { session: readerSession, tools: readerTools.map((tool) => tool.name), final: reader },
    ],
    memory: {
      revisions: history.map((revision) => ({ author: revision.author, body: revision.content?.body, links: revision.content?.links })),
      current: { body: current?.body, links: current?.links },
    },
    graph: edges,
  });
} finally {
  await conn.close?.();
}
```

<details class="pi-bio-output">

<summary>

Output: cell-3
</summary>

``` json
{
  "model": "gpt-5.3-codex-spark",
  "agents": [
    {
      "session": "typed-memory-writer",
      "tools": [
        "bio_remember",
        "bio_remember",
        "bio_remember",
        "bio_remember"
      ],
      "final": "The revision was recorded in memory."
    },
    {
      "session": "typed-memory-reader",
      "tools": [
        "bio_recall",
        "bio_walk_memory",
        "bio_graph_window"
      ],
      "final": "The two current predicates from `analysis-plan` are **depends_on** and **see_also**."
    }
  ],
  "memory": {
    "revisions": [
      {
        "author": "agent:local",
        "body": "Initial plan revision.",
        "links": [
          {
            "to": "source-schema",
            "predicate": "references"
          },
          {
            "to": "review-checklist",
            "predicate": "see_also"
          }
        ]
      },
      {
        "author": "agent:local",
        "body": "Final plan: inspect schema, compose SQL, then review evidence.",
        "links": [
          {
            "to": "source-schema",
            "predicate": "depends_on"
          },
          {
            "to": "review-checklist",
            "predicate": "see_also"
          }
        ]
      }
    ],
    "current": {
      "body": "Final plan: inspect schema, compose SQL, then review evidence.",
      "links": [
        {
          "to": "source-schema",
          "predicate": "depends_on"
        },
        {
          "to": "review-checklist",
          "predicate": "see_also"
        }
      ]
    }
  },
  "graph": [
    {
      "predicate": "depends_on",
      "to_id": "memory:source-schema"
    },
    {
      "predicate": "see_also",
      "to_id": "memory:review-checklist"
    }
  ]
}
```

</details>

The assertions establish more than tool-call compliance: the first
relation revision remains available in temporal history, the second
agent sees the canonical current revision, and the graph contains only
the current typed edges. The dropped `references` edge does not survive
as a phantom relation.
