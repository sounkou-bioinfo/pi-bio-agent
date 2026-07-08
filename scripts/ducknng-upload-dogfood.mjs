#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");

function resolveFromRepo(path) {
  return resolve(repoRoot, path);
}

async function exists(path) {
  try {
    await fs.access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (path && await exists(path)) return path;
  }
  return null;
}

async function run(cmd, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ...options.env },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return `${stdout}\n${stderr}`;
}

function testSummaryCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`(?:^|\\n).*?\\b${label}\\s+(\\d+)\\b`, "gi"))];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1]?.[1] ?? NaN);
}

const ducknngRepo = process.env.DUCKNNG_REPO ? resolveFromRepo(process.env.DUCKNNG_REPO) : resolve(repoRoot, "..", "ducknng");
const extensionPath = await firstExisting([
  process.env.DUCKNNG_EXTENSION_PATH ? resolveFromRepo(process.env.DUCKNNG_EXTENSION_PATH) : undefined,
  join(ducknngRepo, "build", "release", "extension", "ducknng", "ducknng.duckdb_extension"),
  join(ducknngRepo, "build", "release", "ducknng.duckdb_extension"),
  join(ducknngRepo, "build", "debug", "extension", "ducknng", "ducknng.duckdb_extension"),
  join(ducknngRepo, "build", "debug", "ducknng.duckdb_extension"),
]);

if (!extensionPath) {
  throw new Error(
    "ducknng-upload-dogfood: no ducknng.duckdb_extension found. Set DUCKNNG_EXTENSION_PATH or DUCKNNG_REPO to an upload-capable sibling build.",
  );
}

await run(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"]);
const output = await run(process.execPath, ["--test", "dist-test/test/ducknng-upload-shared-data.test.js"], {
  env: { DUCKNNG_EXTENSION_PATH: extensionPath },
});

if (testSummaryCount(output, "skipped") !== 0 || testSummaryCount(output, "todo") !== 0) {
  throw new Error("ducknng-upload-dogfood: upload conformance did not run; it was skipped or marked todo");
}
if (testSummaryCount(output, "pass") !== 1 || testSummaryCount(output, "fail") !== 0) {
  throw new Error("ducknng-upload-dogfood: expected exactly one passing upload conformance test");
}

console.log(JSON.stringify({
  dogfood: "ducknng-upload",
  ok: true,
  extensionPath,
}, null, 2));
