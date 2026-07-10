#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { DuckDBInstance } from "@duckdb/node-api";

import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema, observationAsOfKey } from "../dist/duckdb/observations.js";
import { createJobQueueSchema, enqueueJob, readJobQueueRecord } from "../dist/hosts/job-queue.js";
import { createSqlConnHttpServer } from "../dist/hosts/remote-sql-conn.js";
import { fsCasStore } from "../dist/hosts/fs-cas.js";
import { runBioQueryFromManifest } from "../dist/hosts/run-store.js";

const execFileAsync = promisify(execFile);

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const PROJECT_ROOT = process.cwd();
const MANIFEST_PATH = "examples/variant-counts/manifest.json";
const QUERY_SQL = "SELECT COUNT(*) AS variant_count FROM variants";
const RUN_ID = "dogfood-ssh-remote-worker";
const DEFAULT_REMOTE_HOST = "rig";
const DEFAULT_REMOTE_PORT = 42023;
const LOCAL_BIND_HOST = "127.0.0.1";
const FUTURE_TIMESTAMP = "9999-12-31T23:59:59.999Z";

function validateSshHost(raw) {
  const value = raw?.trim() ?? "";
  if (!value) return DEFAULT_REMOTE_HOST;
  if (value.startsWith("-")) throw new Error("PI_BIO_SSH_HOST must not start with '-'");
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("PI_BIO_SSH_HOST must be one SSH destination");
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function validateRemotePort(raw) {
  const value = raw ?? String(DEFAULT_REMOTE_PORT);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PI_BIO_SSH_REMOTE_PORT must be an integer 1..65535");
  }
  return port;
}

function spawnCapture(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr, code, signal });
      } else {
        reject(new Error(`${file} exited ${code ?? signal}: ${stderr || stdout || "(no output)"}`));
      }
    });

    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

function parseJsonFromOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("command output empty");
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i].trim());
    } catch {
      continue;
    }
  }
  throw new Error("command output has no parseable JSON line");
}

async function runSsh(host, command, input) {
  return spawnCapture("ssh", ["-o", "ExitOnForwardFailure=yes", host, `bash -lc ${shellQuote(command)}`], input);
}

async function runSshForward(host, localPort, remotePort, command, input) {
  return spawnCapture(
    "ssh",
    [
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `${LOCAL_BIND_HOST}:${remotePort}:127.0.0.1:${localPort}`,
      host,
      `bash -lic ${shellQuote(command)}`,
    ],
    input,
  );
}

async function runRsync(localPath, remotePath, host) {
  return spawnCapture("rsync", ["-a", localPath, `${host}:${remotePath}`]);
}

async function waitUntilQueueTerminal(conn, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = await readJobQueueRecord(conn, runId);
    if (!rec) return null;
    if (rec.phase !== "queued" && rec.phase !== "running" && rec.phase !== "waiting") return rec;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return readJobQueueRecord(conn, runId);
}

async function waitUntilQueueResult(conn, runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await observationAsOfKey(conn, `job:${runId}:result`, FUTURE_TIMESTAMP);
    if (row?.value_json) return row;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return observationAsOfKey(conn, `job:${runId}:result`, FUTURE_TIMESTAMP);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const host = validateSshHost(process.env.PI_BIO_SSH_HOST || DEFAULT_REMOTE_HOST);
  const remotePort = validateRemotePort(process.env.PI_BIO_SSH_REMOTE_PORT);
  const coordinatorToken = createHash("sha256").update(randomBytes(24)).digest("hex");
  const workerId = `remote-worker-${createHash("sha256").update(randomBytes(8)).digest("hex").slice(0, 12)}`;

  let localPackDir;
  let localCasDir;
  let remoteRoot;
  let instance;
  let rawConn;
  let server;

  let primaryError;

  try {
    localCasDir = await mkdtemp(join(tmpdir(), "pi-bio-dogfood-cas-"));
    const runResponse = await runBioQueryFromManifest({
      cwd: PROJECT_ROOT,
      dbPath: ":memory:",
      manifestPath: MANIFEST_PATH,
      runId: RUN_ID,
      sql: QUERY_SQL,
      cas: fsCasStore(localCasDir),
    });
    assert.equal(runResponse.ok, true);
    const replayPath = resolve(runResponse.runDir, "replay.json");
    const replay = JSON.parse(await fs.readFile(replayPath, "utf8"));
    assert.equal(replay.runId, RUN_ID);

    instance = await DuckDBInstance.create(":memory:");
    rawConn = await instance.connect();
    const conn = duckdbNodeConn(rawConn);

    await createBioObservationSchema(conn, { ifNotExists: true });
    await createJobQueueSchema(conn, { ifNotExists: true });

    server = await createSqlConnHttpServer({
      conn,
      bearerToken: coordinatorToken,
    });

    await enqueueJob(conn, {
      runId: replay.runId,
      replay,
      now: "2026-07-01T00:00:00.000Z",
    });

    localPackDir = await mkdtemp(join(tmpdir(), "pi-bio-dogfood-pack-"));
    const pack = await execFileAsync(npmCmd, ["pack", "--json", "--ignore-scripts", "--pack-destination", localPackDir], { cwd: PROJECT_ROOT });
    const packItems = JSON.parse(pack.stdout);
    const packItem = Array.isArray(packItems) ? packItems[0] : packItems;
    const tarballName = typeof packItem?.filename === "string" ? packItem.filename : "";
    if (!tarballName) throw new Error("npm pack did not report a tarball filename");
    const tarballPath = resolve(localPackDir, tarballName);

    const remoteRootText = await runSsh(host, "mktemp -d /tmp/pi-bio-remote-dogfood-XXXXXX");
    remoteRoot = remoteRootText.stdout.trim();
    if (!remoteRoot) throw new Error("failed to allocate remote temp directory");

    const remoteAppDir = `${remoteRoot}/app`;
    const remoteWorkspace = `${remoteAppDir}/workspace`;
    const remoteCas = `${remoteWorkspace}/cas`;
    await runSsh(host, `mkdir -p ${shellQuote(`${remoteWorkspace}/data`)}`);

    await runRsync(tarballPath, `${remoteAppDir}/`, host);
    await runRsync(resolve(PROJECT_ROOT, "examples/variant-counts/data/variants.csv"), `${remoteWorkspace}/data/`, host);

    const remoteCommand = [
      `cd ${shellQuote(remoteAppDir)}`,
      `npm install --ignore-scripts --no-audit --no-fund --package-lock=false ${shellQuote(tarballName)}`,
      `node node_modules/pi-bio-agent/scripts/dogfood-remote-worker-helper.mjs`,
    ].join(" && ");

    const remoteConfig = {
      endpoint: `http://${LOCAL_BIND_HOST}:${remotePort}`,
      bearerToken: coordinatorToken,
      workspacePath: remoteWorkspace,
      casRoot: remoteCas,
      runId: replay.runId,
      workerId,
      replay,
    };
    const remoteResult = parseJsonFromOutput((await runSshForward(host, server.port, remotePort, remoteCommand, JSON.stringify(remoteConfig))).stdout);

    const queueRec = await waitUntilQueueTerminal(conn, replay.runId);
    if (!queueRec) throw new Error("did not read queued job result");
    if (queueRec.phase !== "succeeded") throw new Error(`remote queue phase was '${queueRec.phase}', expected 'succeeded'`);
    if (queueRec.attempt !== 1) throw new Error(`remote queue attempt was ${queueRec.attempt}, expected 1`);

    const queueResultRow = await waitUntilQueueResult(conn, replay.runId);
    if (!queueResultRow?.value_json) throw new Error("missing job result observation");

    let queueResultPayload;
    try {
      queueResultPayload = JSON.parse(queueResultRow.value_json);
    } catch (error) {
      throw new Error(`invalid queue result JSON: ${toErrorMessage(error)}`);
    }
    if (queueResultPayload.schema !== "pi-bio.job_result.v1") throw new Error("unexpected queue result schema");
    if (typeof queueResultPayload.result?.expectedResultDigest !== "string") {
      throw new Error("durable queue result has no pinned output digest");
    }
    if (queueResultPayload.result?.matched !== true || queueResultPayload.result?.resultMatched !== true) {
      throw new Error(`durable queue result not matched: ${JSON.stringify(queueResultPayload.result)}`);
    }

    if (!replay.manifest?.snapshot) throw new Error("replay snapshot is missing");
    const remoteRepro = remoteResult.replayResult;
    if (typeof remoteRepro?.expectedResultDigest !== "string") {
      throw new Error("remote reproduction has no pinned output digest");
    }
    if (remoteRepro?.matched !== true || remoteRepro?.resultMatched !== true) {
      throw new Error(`remote reproduction verdict did not pass: ${JSON.stringify(remoteRepro)}`);
    }
    if (remoteResult.sourceManifestExists) throw new Error("remote host contains the replay's original manifest path");

    const summary = {
      host,
      transport: {
        type: "ssh-forward",
        remoteForward: `${LOCAL_BIND_HOST}:${remotePort} -> ${LOCAL_BIND_HOST}:${server.port}`,
      },
      runId: RUN_ID,
      queue: {
        phase: queueRec.phase,
        attempt: queueRec.attempt,
      },
      snapshotOnlyExecution: {
        snapshotProvided: !!replay.manifest.snapshot,
        sourceManifestMissing: !remoteResult.sourceManifestExists,
      },
      resultMatch: {
        matched: queueResultPayload.result.matched,
        resultMatched: queueResultPayload.result.resultMatched,
      },
    };

    console.log(JSON.stringify(summary));
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];

    if (server) {
      try {
        await server.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (rawConn) {
      try {
        rawConn.closeSync();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (instance) {
      try {
        instance.closeSync();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (localPackDir) {
      try {
        await fs.rm(localPackDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (localCasDir) {
      try {
        await fs.rm(localCasDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (remoteRoot) {
      try {
        await runSsh(host, `rm -rf ${shellQuote(remoteRoot)}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (primaryError) {
      if (cleanupErrors.length > 0) {
        const suffix = cleanupErrors.map((error) => toErrorMessage(error)).join("; ");
        throw new Error(`${toErrorMessage(primaryError)}; cleanup failures: ${suffix}`);
      }
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  }
}

await main();
