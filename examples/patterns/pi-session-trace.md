# Live Pi session into the observation ledger


A real Pi session reads an image, runs a successful and a failing shell
command, inspects a manifest, validates SQL, and executes a query. The
extension imports the session trajectory into the same observation
ledger used by runs and memory.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { sessionToolTrajectory } from "../../dist/hosts/session-ingest.js";

const root = process.cwd();
const workdir = await mkdtemp(join(tmpdir(), "pi-bio-session-qmd-"));
const sessionId = "pi-bio-session-trace-qmd";
const model = process.env.PI_BIO_PATTERN_MODEL ?? "gpt-5.3-codex-spark";
await writeFile(join(workdir, "plot.png"), Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAkUlEQVR4nO3RAQ0AAAgDINc/9K3hHBQg7k5mZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwH8G0AABhYqS2gAAAABJRU5ErkJggg==",
  "base64",
));
await writeFile(join(workdir, "data.csv"), "variant,consequence\nv1,missense\nv2,stop_gained\nv3,missense\n");
await writeFile(join(workdir, "manifest.json"), JSON.stringify({
  schema: "pi-bio.manifest.v1",
  id: "session-trace",
  version: "0.1.0",
  title: "Session trace",
  description: "Fixture for session ingestion.",
  provides: {
    resolvers: [{
      id: "duckdb.file_scan", version: "0.1.0", title: "File scan", description: "Read CSV.", output: { mode: "table" },
    }],
    resources: [{ id: "variants", title: "Variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data.csv", table: "variants" } }],
  },
}, null, 2));

const prompt = [
  "Use tools in exactly this order and continue after the expected failure:",
  "1. read plot.png and identify it as an image.",
  "2. bash: wc -l data.csv",
  "3. bash: cat missing.txt",
  "4. bio_describe_model on manifest.json",
  "5. bio_validate_select for SELECT consequence, count(*) AS n FROM variants GROUP BY 1 ORDER BY 1",
  "6. bio_query with dbPath :memory:, manifestPath manifest.json, and that SQL.",
  "Finish with one concise sentence.",
].join("\n");
await new Promise((resolveRun, reject) => {
  const providerArgs = model.includes("/") ? ["--model", model] : ["--provider", "openai-codex", "--model", model];
  const child = spawn("pi", [
    ...providerArgs,
    "--thinking", "high",
    "--extension", resolve(root, "extensions/pi-coding-agent/index.ts"),
    "--no-extensions", "--no-skills", "--no-context-files",
    "--tools", "read,bash,bio_describe_model,bio_validate_select,bio_query",
    "--session-id", sessionId,
    "-p", `@${join(workdir, "plot.png")}`, prompt,
  ], { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`pi exited ${String(code ?? signal)}: ${stderr.slice(-1000)}`)));
});

const instance = await DuckDBInstance.create(join(workdir, ".pi/bio-agent/store.duckdb"));
const conn = duckdbNodeConn(await instance.connect());
const tools = await sessionToolTrajectory(conn, sessionId);
const links = await conn.all(`SELECT subject_id, predicate, object_id FROM bio_observations
  WHERE predicate IN ('executes', 'invoked_by') ORDER BY recorded_at, subject_id`);
await conn.close?.();
assert.deepEqual(tools.map((tool) => tool.name), ["read", "bash", "bash", "bio_describe_model", "bio_validate_select", "bio_query"]);
assert.ok(tools.some((tool) => tool.name === "bash" && tool.isError));
assert.ok(links.some((edge) => edge.predicate === "executes" && edge.object_id?.startsWith("run:")));
piBio.json({
  pattern: "pi-session-trace",
  model,
  tools: tools.map((tool) => ({ name: tool.name, isError: tool.isError })),
  runLinkCount: links.filter((edge) => edge.predicate === "executes").length,
});
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "pattern": "pi-session-trace",
  "model": "gpt-5.3-codex-spark",
  "tools": [
    {
      "name": "read",
      "isError": false
    },
    {
      "name": "bash",
      "isError": false
    },
    {
      "name": "bash",
      "isError": true
    },
    {
      "name": "bio_describe_model",
      "isError": false
    },
    {
      "name": "bio_validate_select",
      "isError": false
    },
    {
      "name": "bio_query",
      "isError": false
    }
  ],
  "runLinkCount": 1
}
```

</details>

This proves Pi lifecycle ingestion, ordered tool-call retention
(including an error), and tool-call/run linkage. The `read` call is part
of the imported trajectory; this run does not claim a separately
projected image artifact. Pi session JSONL is a source format, while
imported observations and CAS references are the shared surface.
