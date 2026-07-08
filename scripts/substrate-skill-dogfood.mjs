#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const cli = join(repoRoot, "dist", "cli", "bin.js");

async function runCli(cwd, args) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout);
}

async function scalar(dbPath, sql, params = []) {
  const instance = await DuckDBInstance.create(dbPath);
  const raw = await instance.connect();
  const conn = duckdbNodeConn(raw);
  try {
    const rows = await conn.all(sql, params);
    return Number(Object.values(rows[0] ?? { n: 0 })[0]);
  } finally {
    raw.closeSync();
  }
}

const pkg = JSON.parse(await fs.readFile(join(repoRoot, "package.json"), "utf8"));
assert.deepEqual(pkg.pi?.skills, ["./skills"], "package exposes skills to hosts that understand package skills");

const skillText = await fs.readFile(join(repoRoot, "skills", "pi-bio-agent", "SKILL.md"), "utf8");
assert.match(skillText, /pi-bio-agent query\/run/, "skill points non-Pi hosts at the CLI substrate");
assert.match(skillText, /pi-bio-agent catalog/, "skill points non-Pi hosts at manifest-backed source discovery");
assert.match(skillText, /pi-bio-agent graph-window/, "skill points non-Pi hosts at bounded graph inspection");
assert.match(skillText, /ClawBio-like systems/, "skill names the ClawBio-style anti-sprawl migration path");
assert.match(skillText, /Skill Graduation Rule/, "skill keeps skills as graduation, not the computation");

const workdir = await fs.mkdtemp(join(tmpdir(), "pi-bio-substrate-skill-"));
await fs.cp(join(repoRoot, "examples", "rare-high-impact"), workdir, { recursive: true });

const catalog = await runCli(repoRoot, [
  "catalog",
  "--root", "examples",
  "--query", "rare",
]);
assert.equal(catalog.ok, undefined, "catalog is a discovery document, not a run response");
const rareEntry = catalog.entries.find((entry) => entry.manifestPath === "examples/rare-high-impact/manifest.json");
assert.ok(rareEntry, "catalog discovers the rare-high-impact manifest before a host runs it");
assert.deepEqual(rareEntry.operations.map((op) => op.id), ["rare_high_impact.report"]);

const described = await runCli(workdir, [
  "query", "manifest.json",
  "--db", ":memory:",
  "--sql", "DESCRIBE annotated_variants",
]);
assert.equal(described.ok, true);
assert.deepEqual(described.rows.map((row) => row.column_name), [
  "variant_key",
  "consequence",
  "allele_frequency",
  "clinical_significance",
]);

const run = await runCli(workdir, [
  "run", "manifest.json",
  "--db", ":memory:",
  "--operation", "rare_high_impact.report",
  "--ledger", "auto",
  "--author", "substrate-skill-dogfood",
]);
assert.equal(run.ok, true);
const buckets = new Map(run.rows.map((row) => [row.bucket, Number(row.n)]));
assert.equal(buckets.get("included"), 1);
assert.equal(buckets.get("no_frequency"), 1);
assert.equal(buckets.get("benign"), 1);

const storePath = join(workdir, ".pi", "bio-agent", "store.duckdb");
const runFactCount = await scalar(
  storePath,
  "SELECT count(*) AS n FROM bio_observations WHERE subject_id = ? AND predicate = 'run'",
  [`run:${run.runId}`],
);
assert.equal(runFactCount, 1, "CLI dogfood run is recorded as a run:<id> ledger fact");

const graphDbPath = join(workdir, "graph-window.duckdb");
const graphMaterialized = await runCli(workdir, [
  "query", join(repoRoot, "examples", "graph-window", "manifest.json"),
  "--db", graphDbPath,
  "--sql", "SELECT count(*) AS n FROM bio_edges",
]);
assert.equal(graphMaterialized.ok, true);
assert.equal(Number(graphMaterialized.rows[0]?.n), 4, "graph-window example materialized four edge rows");

const graphWindow = await runCli(workdir, [
  "graph-window",
  "--db", graphDbPath,
  "--table", "bio_edges",
  "--start", "run:readme",
  "--direction", "both",
  "--limit", "2",
]);
assert.equal(graphWindow.schema, "pi-bio.graph_query_window.v1");
assert.equal(graphWindow.totalCount, 4);
assert.equal(graphWindow.rows.length, 2);
assert.equal(graphWindow.omittedCount, 2);
assert.match(graphWindow.continuation?.pointer?.uri ?? "", /^graph-window:/);

const graphWindowNext = await runCli(workdir, [
  "graph-window",
  "--db", graphDbPath,
  "--continuation", graphWindow.continuation.pointer.uri,
]);
assert.equal(graphWindowNext.rows.length, 2);
assert.equal(graphWindowNext.omittedCount, 0);

console.log(JSON.stringify({
  dogfood: "substrate-skill",
  ok: true,
  integrationPoint: "package skill -> non-Pi host -> catalog -> pi-bio-agent CLI -> manifest SQL + graph-window paging + observation ledger",
  skill: "skills/pi-bio-agent/SKILL.md",
  catalogEntry: rareEntry.manifestPath,
  manifest: "examples/rare-high-impact/manifest.json",
  runId: run.runId,
  buckets: Object.fromEntries(buckets),
  ledgerRunFacts: runFactCount,
  graphWindow: {
    totalCount: graphWindow.totalCount,
    firstPageRows: graphWindow.rows.length,
    secondPageRows: graphWindowNext.rows.length,
  },
}, null, 2));
