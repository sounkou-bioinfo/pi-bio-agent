#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { createQueueJobWorker, createSqlConnHttpClient, fsCasStore, reproduceRun } from "pi-bio-agent";
import { observationAsOfKey } from "pi-bio-agent/duckdb";

const FUTURE_TIMESTAMP = "9999-12-31T23:59:59.999Z";

function fail(message, cause) {
  const error = new Error(cause ? `${message}: ${cause instanceof Error ? cause.message : String(cause)}` : message);
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exitCode = 1;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty helper config on stdin");
  return JSON.parse(raw);
}

async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertReplay(value) {
  if (!value || typeof value !== "object" || value.schema !== "pi-bio.run_replay_spec.v1") {
    throw new Error("config.replay must be a RunReplaySpec with schema pi-bio.run_replay_spec.v1");
  }
  if (typeof value.runId !== "string" || value.runId.trim().length === 0) {
    throw new Error("config.replay.runId must be a non-empty string");
  }
}

async function readQueueResult(conn, runId) {
  const resultRow = await observationAsOfKey(conn, `job:${runId}:result`, FUTURE_TIMESTAMP);
  if (!resultRow?.value_json) throw new Error(`queue result observation for job:${runId}:result was not found`);
  const parsed = JSON.parse(resultRow.value_json);
  if (!parsed || typeof parsed !== "object" || parsed.schema !== "pi-bio.job_result.v1") {
    throw new Error("queue result observation payload schema mismatch");
  }
  return parsed;
}

try {
  const config = await readStdinJson();
  assertString(config.endpoint, "config.endpoint");
  assertString(config.bearerToken, "config.bearerToken");
  assertString(config.workspacePath, "config.workspacePath");
  assertString(config.casRoot, "config.casRoot");
  assertString(config.workerId, "config.workerId");
  assertString(config.runId, "config.runId");
  assertReplay(config.replay);

  const queueConn = createSqlConnHttpClient({
    endpoint: config.endpoint,
    bearerToken: config.bearerToken,
  });

  const worker = createQueueJobWorker(queueConn, {
    clock: () => new Date().toISOString(),
    workerId: config.workerId,
    leaseSeconds: 120,
    executor: async (replay) => {
      const result = await reproduceRun({
        cwd: config.workspacePath,
        replay,
        cas: fsCasStore(config.casRoot),
        manifestBaseDir: config.workspacePath,
      });
      return { result };
    },
  });

  const claimed = await worker.runOne();
  if (!claimed) {
    throw new Error(`no queued job available for runId '${config.runId}'`);
  }

  const queueResult = await readQueueResult(queueConn, config.runId);
  const replayResult = queueResult.result;
  const sourceManifestExists = typeof config.replay.manifest?.path === "string"
    ? await fileExists(resolve(config.workspacePath, config.replay.manifest.path))
    : false;

  console.log(JSON.stringify({
    ok: true,
    runId: config.runId,
    queueResult,
    replayResult,
    sourceManifestExists,
    workerId: config.workerId,
  }));
} catch (error) {
  fail("remote helper failed", error);
}
