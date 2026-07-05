#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const model = process.env.PI_BIO_DOGFOOD_MODEL ?? "openai-codex/gpt-5.5";
const providerArgs = model.includes("/") ? ["--model", model] : ["--provider", "openai-codex", "--model", model];
const sessionId = `pi-bio-dogfood-${Date.now().toString(36)}`;
const workdir = await mkdtemp(join(tmpdir(), "pi-bio-session-trace-"));

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? repoRoot,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} failed with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeFixtureProject(dir) {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAkUlEQVR4nO3RAQ0AAAgDINc/9K3hHBQg7k5mZgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwH8G0AABhYqS2gAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(dir, "plot.png"), png);
  await writeFile(join(dir, "data.csv"), [
    "variant,consequence,impact",
    "v1,missense,HIGH",
    "v2,stop_gained,HIGH",
    "v3,missense,MODERATE",
    "v4,stop_gained,HIGH",
    "v5,synonymous,LOW",
  ].join("\n") + "\n");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    schema: "pi-bio.manifest.v1",
    id: "session-trace-dogfood",
    version: "0.1.0",
    title: "Session trace dogfood",
    description: "Tiny manifest used by scripts/pi-session-trace-dogfood.mjs.",
    provides: {
      resolvers: [
        {
          id: "duckdb.file_scan",
          version: "0.1.0",
          title: "DuckDB file scan",
          description: "Read a local CSV into DuckDB.",
          output: { mode: "table" },
        },
      ],
      resources: [
        {
          id: "variants",
          title: "Variants",
          kind: "virtual",
          resolver: "duckdb.file_scan",
          params: { path: "data.csv", table: "variants" },
        },
      ],
    },
  }, null, 2));
  return createHash("sha256").update(png).digest("hex");
}

async function queryTrace(projectDir, id) {
  const { duckdbNodeConn } = await import("../dist/duckdb/node-api.js");
  const { sessionArtifacts, sessionTimeline, sessionToolTrajectory } = await import("../dist/hosts/session-ingest.js");
  const dbPath = join(projectDir, ".pi", "bio-agent", "store.duckdb");
  const instance = await DuckDBInstance.create(dbPath);
  const conn = duckdbNodeConn(await instance.connect());
  try {
    const summaryRows = await conn.all(
      "SELECT value_json FROM bio_observations WHERE subject_id = ? AND predicate = 'session' ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC LIMIT 1",
      [`session:${id}`],
    );
    const summary = summaryRows[0]?.value_json ? JSON.parse(summaryRows[0].value_json) : null;
    const rawDigest = typeof summary?.raw_digest === "string" ? summary.raw_digest : null;
    const rawSessionPath = rawDigest?.startsWith("sha256:")
      ? join(projectDir, ".pi", "bio-agent", "cas", "sha256", rawDigest.slice("sha256:".length))
      : null;
    const rawSession = rawSessionPath ? await readFile(rawSessionPath, "utf8") : "";
    const timeline = await sessionTimeline(conn, id);
    const tools = await sessionToolTrajectory(conn, id);
    const artifacts = await sessionArtifacts(conn, id);
    const links = await conn.all(
      `SELECT subject_id, predicate, object_id
       FROM bio_observations
       WHERE predicate IN ('executes', 'invoked_by')
         AND (starts_with(subject_id, 'toolcall:') OR starts_with(subject_id, 'run:'))
       ORDER BY recorded_at::TIMESTAMPTZ, subject_id, predicate`,
    );
    const runFacts = await conn.all(
      "SELECT subject_id, value_json FROM bio_observations WHERE starts_with(subject_id, 'run:') AND predicate = 'run' ORDER BY recorded_at::TIMESTAMPTZ",
    );
    return { dbPath, summary, timeline, tools, artifacts, links, runFacts, rawSessionPath, rawSession };
  } finally {
    await conn.close?.();
  }
}

await run("npm", ["run", "build"]);
const pngDigest = await writeFixtureProject(workdir);

const prompt = [
  "Create a trace for pi-bio-agent dogfooding. You must use tools, in this order:",
  "1. Use read on plot.png and mention that it is an image.",
  "2. Use bash to run `wc -l data.csv`.",
  "3. Use bash to run `cat missing.txt`; this is expected to fail, continue after the error.",
  "4. Use bio_describe_model on manifest.json.",
  "5. Use bio_validate_select for `SELECT consequence, count(*) AS n FROM variants GROUP BY 1 ORDER BY 1`.",
  "6. Use bio_query with dbPath ':memory:', manifestPath 'manifest.json', and that SQL.",
  "Finish with only a compact summary of the counts and the expected failed command.",
].join("\n");

console.log(`project: ${workdir}`);
console.log(`session: ${sessionId}`);
console.log(`model: ${model}`);
console.log("running live Pi session...");

const pi = await run("pi", [
  ...providerArgs,
  "--thinking", "high",
  "--tools", "read,bash,bio_describe_model,bio_validate_select,bio_query",
  "--session-id", sessionId,
  "--name", "pi-bio trace dogfood",
  "-p",
  `@${join(workdir, "plot.png")}`,
  prompt,
], { cwd: workdir });

process.stdout.write(pi.stdout);
if (pi.stderr.trim()) process.stderr.write(pi.stderr);

const trace = await queryTrace(workdir, sessionId);
if (!trace.summary) throw new Error(`session ${sessionId} was not ingested into ${trace.dbPath}`);

const hasError = trace.tools.some((tool) => tool.isError === true);
const hasBioRunLink = trace.links.some((edge) => edge.predicate === "executes" && edge.subject_id.startsWith(`toolcall:${sessionId}:`) && edge.object_id?.startsWith("run:"));
const hasImageArtifact = trace.artifacts.some((artifact) => artifact.mediaType.startsWith("image/"));
const hasImageRead = trace.rawSession.includes("Read image file [image/png]") || trace.rawSession.includes("[Image omitted:");

console.log("\n=== ledger proof ===");
console.log(JSON.stringify({
  store: trace.dbPath,
  session: sessionId,
  entries: trace.summary.entries,
  messages: trace.summary.messages,
  turns: trace.summary.turns,
  toolCalls: trace.summary.tool_calls,
  artifacts: trace.summary.artifacts,
  timelineRoles: trace.timeline.map((row) => row.role),
  tools: trace.tools.map((tool) => ({ name: tool.name, isError: tool.isError })),
  artifactTypes: trace.artifacts.map((artifact) => ({
    mediaType: artifact.mediaType,
    semanticRole: artifact.semanticRole,
    sizeBytes: artifact.sizeBytes,
    sourceNode: artifact.sourceNode,
  })),
  rawSessionCasPath: trace.rawSessionPath,
  imageReadRecordedInRawSession: hasImageRead,
  imageArtifactCaptured: hasImageArtifact,
  runLinks: trace.links,
  runFacts: trace.runFacts.map((run) => run.subject_id),
  pngSha256: `sha256:${pngDigest}`,
}, null, 2));

if (!hasError) throw new Error("dogfood trace did not capture an error tool result");
if (!hasImageRead) throw new Error("dogfood trace did not record the image read in the raw session");
if (!hasBioRunLink) throw new Error("dogfood trace did not capture toolcall->run link");
