#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DuckDBInstance } from "@duckdb/node-api";

import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import {
  createBioObservationSchema,
  materializeBioEdgesAsOf,
  observationAsOfKey,
  recordObservation,
  recordObservationLink,
} from "../dist/duckdb/observations.js";
import { materializeGraphProjectionProfile } from "../dist/duckdb/graph-projection.js";
import { refreshDucknngHttpProfile } from "../dist/duckdb/http-profiles.js";
import { envDescriptorFromRenvLock, envDigest, validateEnvDescriptor } from "../dist/core/reproducibility.js";
import { fsCasStore } from "../dist/hosts/fs-cas.js";
import { recordArtifactReference } from "../dist/hosts/artifacts.js";
import { recordHostEvent } from "../dist/hosts/host-events.js";
import { ingestSessionJsonl } from "../dist/hosts/session-ingest.js";
import { exportTrainingCorpusParquet } from "../dist/hosts/training-corpus.js";
import { nodeComputeRunner, withObservedEnvironment } from "../dist/hosts/index.js";
import { claimJob, createJobQueueSchema, recordJobClaimStatus } from "../dist/hosts/job-queue.js";
import {
  cancelBioJob,
  jobStepCheckpointKey,
  readJobStepCheckpoint,
  resumeBioJob,
  runJobStepsWithCheckpoints,
  submitBioJob,
} from "../dist/hosts/job-store.js";
import { queueJobRunner } from "../dist/hosts/queue-job-runner.js";
import { reproduceRun } from "../dist/hosts/reproduce.js";
import { runBioQueryFromManifest } from "../dist/hosts/run-store.js";

const NOW = "2026-07-06T12:00:00.000Z";
const LATER = "2026-07-06T12:00:05.000Z";
const REPLAY_DIGEST = `sha256:${"1".repeat(64)}`;
const execFileAsync = promisify(execFile);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const instance = await DuckDBInstance.create(":memory:");
const raw = await instance.connect();
const conn = duckdbNodeConn(raw);

function asNumber(value) {
  return Number(value ?? 0);
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

class FakeDucknngProfileConn {
  sqlSeen = [];
  authValuesSeen = [];
  profiles = new Map();
  nowMs = 1783283000000n;

  async run() {
    throw new Error("FakeDucknngProfileConn.run is not used by this dogfood");
  }

  async all(sql, params) {
    this.sqlSeen.push(sql);
    if (sql.includes("duckdb_functions()")) return [{ n: 1n }];
    if (sql.includes("ducknng_list_http_profiles()")) return [...this.profiles.values()].map((row) => ({ ...row }));
    if (sql.includes("ducknng_register_http_profile")) {
      assert.ok(params && params.length >= 9, "ducknng profile registration is parameter-bound");
      const profileId = String(params[0]);
      const existing = this.profiles.get(profileId);
      const createdMs = existing?.created_ms ?? this.tick();
      const updatedMs = existing ? this.tick() : createdMs;
      const expiresAtMs = params.length >= 10 ? BigInt(params[9]) : 0n;
      const allowSubjectsJson = params.length >= 11 ? String(params[10]) : null;
      this.authValuesSeen.push(String(params[8]));
      this.profiles.set(profileId, {
        profile_id: profileId,
        scheme: String(params[1]),
        host: String(params[2]),
        port: params[3] == null ? null : Number(params[3]),
        has_port: params[3] != null,
        path_prefix: String(params[4]),
        method: String(params[5]),
        tls_required: Boolean(params[6]),
        auth_header_names_json: JSON.stringify([String(params[7])]),
        version: (existing?.version ?? 0n) + 1n,
        created_ms: createdMs,
        updated_ms: updatedMs,
        expires_at_ms: expiresAtMs,
        allow_subjects_json: allowSubjectsJson,
      });
      return [{ ok: true }];
    }
    throw new Error(`FakeDucknngProfileConn does not implement SQL: ${sql}`);
  }

  tick() {
    this.nowMs += 1000n;
    return this.nowMs;
  }
}

async function compileExternalConsumer() {
  const consumerRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-sdk-consumer-"));
  try {
    await fs.writeFile(join(consumerRoot, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    const packed = await execFileAsync(npmCmd, ["pack", "--silent", "--pack-destination", consumerRoot], {
      cwd: process.cwd(),
      maxBuffer: 2 * 1024 * 1024,
    });
    const tarball = join(consumerRoot, packed.stdout.trim().split(/\r?\n/).at(-1));
    await execFileAsync(npmCmd, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--prefer-offline", tarball], {
      cwd: consumerRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    await fs.writeFile(join(consumerRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["consumer.ts"],
    }), "utf8");
    await fs.writeFile(join(consumerRoot, "consumer.ts"), `
import {
  runBioQueryFromManifest,
  recordHostEvent,
  ingestSessionJsonl,
  exportTrainingCorpusParquet,
  type HostCapabilityReceipt,
  type CasStore,
} from "pi-bio-agent";
import {
  validateBioManifest,
  envDescriptorFromRenvLock,
  envDigest,
  wrapSqlConn,
  type BioManifest,
  type SqlConn,
  type SqlConnPolicy,
} from "pi-bio-agent/core";
import {
  duckdbNodeConn,
  materializeGraphProjectionProfile,
  refreshDucknngHttpProfile,
} from "pi-bio-agent/duckdb";
import {
  fsCasStore,
  nodeComputeRunner,
  runJobStepsWithCheckpoints,
  withObservedEnvironment,
  type RunQueryRequest,
} from "pi-bio-agent/hosts";

const receipt: HostCapabilityReceipt = { schema: "consumer.policy.v1", policyDigest: "sha256:${"5".repeat(64)}" };
const policy: SqlConnPolicy = ({ sql }) => {
  if (!sql.trim()) throw new Error("empty SQL");
};
const manifest: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "consumer",
  version: "0.1.0",
  title: "Consumer",
  description: "External package compile check.",
  provides: {},
};
const request: RunQueryRequest = {
  cwd: ".",
  dbPath: ":memory:",
  manifestPath: "manifest.json",
  sql: "SELECT 1",
  sqlPolicy: policy,
  hostCapabilityReceipts: [receipt],
};
const renvEnv = envDescriptorFromRenvLock(JSON.stringify({ Packages: { renv: { Package: "renv", Version: "1.0.0" } } }), { path: "renv.lock" });
const scopedConn: SqlConn = wrapSqlConn({ all: async () => [], run: async () => undefined }, policy);
const cas: CasStore = fsCasStore("cas");

void validateBioManifest(manifest);
void envDigest(renvEnv);
void scopedConn;
void cas;
void request;
void runBioQueryFromManifest;
void recordHostEvent;
void ingestSessionJsonl;
void exportTrainingCorpusParquet;
void duckdbNodeConn;
void materializeGraphProjectionProfile;
void refreshDucknngHttpProfile;
void fsCasStore;
void nodeComputeRunner;
void runJobStepsWithCheckpoints;
void withObservedEnvironment;
type _Conn = SqlConn;
`, "utf8");
    await execFileAsync(process.execPath, [
      resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(consumerRoot, "tsconfig.json"),
    ], { cwd: consumerRoot, maxBuffer: 2 * 1024 * 1024 });
    await fs.writeFile(join(consumerRoot, "smoke.mjs"), `
import { runBioQueryFromManifest, recordHostEvent, ingestSessionJsonl, exportTrainingCorpusParquet } from "pi-bio-agent";
import { validateBioManifest } from "pi-bio-agent/core";
import { duckdbNodeConn, materializeGraphProjectionProfile, refreshDucknngHttpProfile } from "pi-bio-agent/duckdb";
import { fsCasStore, runJobStepsWithCheckpoints, withObservedEnvironment } from "pi-bio-agent/hosts";

for (const [name, value] of Object.entries({
  runBioQueryFromManifest,
  recordHostEvent,
  ingestSessionJsonl,
  exportTrainingCorpusParquet,
  validateBioManifest,
  duckdbNodeConn,
  materializeGraphProjectionProfile,
  refreshDucknngHttpProfile,
  fsCasStore,
  runJobStepsWithCheckpoints,
  withObservedEnvironment,
})) {
  if (typeof value !== "function") throw new Error(\`public runtime export '\${name}' is not callable\`);
}
`, "utf8");
    await execFileAsync(process.execPath, [join(consumerRoot, "smoke.mjs")], { cwd: consumerRoot, maxBuffer: 2 * 1024 * 1024 });
    return { publicExportsOnly: true, runtimeImports: true, packageSource: "npm-pack", imports: ["pi-bio-agent", "pi-bio-agent/core", "pi-bio-agent/duckdb", "pi-bio-agent/hosts"] };
  } finally {
    await fs.rm(consumerRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

try {
  const sdkConsumer = await compileExternalConsumer();
  await createBioObservationSchema(conn);
  await createJobQueueSchema(conn);

  const renvLockText = JSON.stringify({
    R: { Version: "4.6.0", Repositories: [{ Name: "CRAN", URL: "https://cloud.r-project.org" }] },
    Bioconductor: { Version: "3.22" },
    Packages: {
      renv: { Package: "renv", Version: "1.0.0", Source: "Repository", Repository: "CRAN" },
      BiocGenerics: { Package: "BiocGenerics", Version: "0.52.0", Source: "Bioconductor", Repository: "Bioconductor" },
    },
  }, null, 2);
  const renvEnv = envDescriptorFromRenvLock(renvLockText, { path: "renv.lock", notes: ["dogfood R/Bioconductor lock"] });
  assert.deepEqual(validateEnvDescriptor(renvEnv), []);
  const renvEnvDigest = envDigest(renvEnv);
  assert.match(renvEnvDigest, /^sha256:[0-9a-f]{64}$/);

  const hostEvent = await recordHostEvent(conn, {
    subjectId: "session:dogfood",
    kind: "workbench.input.steer",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
    digest: `sha256:${"2".repeat(64)}`,
    value: {
      payload_digest: `sha256:${"3".repeat(64)}`,
      delivery: "mid_turn",
      redacted: true,
    },
    links: [
      { predicate: "affects", objectId: "turn:dogfood:review", attrs: { reason: "user_steer" } },
      { predicate: "context_sent_to", objectId: "model_call:dogfood:review" },
    ],
  });
  assert.equal(hostEvent.linkObservationIds.length, 2);

  await recordObservationLink(conn, {
    subjectId: "workflow:dogfood:step:report",
    predicate: "depends_on",
    objectId: "workflow:dogfood:step:score",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
  });
  await recordObservationLink(conn, {
    subjectId: "workflow:dogfood:step:score",
    predicate: "depends_on",
    objectId: "workflow:dogfood:step:extract",
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
  });

  let extractExecutions = 0;
  let scoreExecutions = 0;
  const workflowCwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-workflow-"));
  const workflowRunner = nodeComputeRunner();
  async function runWorkflowBashStep(stepId, script, env = {}) {
    const handle = await workflowRunner.submit({
      command: ["bash", "-lc", script],
      cwd: workflowCwd,
      env,
      timeoutMs: 5_000,
    });
    const submittedStatus = await workflowRunner.status(handle);
    const result = await workflowRunner.collect(handle);
    assert.equal(
      result.exitCode,
      0,
      `${stepId} failed with exit ${result.exitCode}; stderr=${result.stderr}`,
    );
    assert.equal(result.timedOut, false);
    return {
      backend: handle.backend ?? "unknown",
      runId: handle.runId,
      submittedPhase: submittedStatus?.phase ?? "unknown",
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }
  const firstPlan = await runJobStepsWithCheckpoints(conn, {
    runId: "dogfood-workflow",
    recordedAt: "2026-07-06T12:00:01.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 1,
    steps: [
      {
        stepId: "extract/variants",
        run: async () => {
          extractExecutions += 1;
          const step = await runWorkflowBashStep(
            "extract/variants",
            "printf '%s\\n' '{\"rows\":5,\"artifact_uri\":\"cas:sha256:variants-fixture\"}' | tee extract-variants.json",
          );
          return {
            ...JSON.parse(step.stdout),
            process_backend: step.backend,
            process_run_id: step.runId,
            process_submitted_phase: step.submittedPhase,
            stdout_digest: sha256(step.stdout),
          };
        },
      },
    ],
  });
  const resumedPlan = await runJobStepsWithCheckpoints(conn, {
    runId: "dogfood-workflow",
    recordedAt: "2026-07-06T12:00:02.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 2,
    steps: [
      {
        stepId: "extract/variants",
        run: async () => {
          extractExecutions += 1;
          const step = await runWorkflowBashStep(
            "extract/variants",
            "printf '%s\\n' '{\"rows\":99}' | tee extract-variants-rerun.json",
          );
          return {
            ...JSON.parse(step.stdout),
            process_backend: step.backend,
            process_run_id: step.runId,
            stdout_digest: sha256(step.stdout),
          };
        },
      },
      {
        stepId: "score/high-impact",
        run: async ({ valueOf }) => {
          scoreExecutions += 1;
          const extract = valueOf("extract/variants");
          const step = await runWorkflowBashStep(
            "score/high-impact",
            "printf '{\"candidates\":2,\"upstream_rows\":%s}\\n' \"$INPUT_ROWS\" | tee score-high-impact.json",
            { INPUT_ROWS: String(extract.rows) },
          );
          return {
            ...JSON.parse(step.stdout),
            upstream_checkpoint: jobStepCheckpointKey("dogfood-workflow", "extract/variants"),
            process_backend: step.backend,
            process_run_id: step.runId,
            process_submitted_phase: step.submittedPhase,
            stdout_digest: sha256(step.stdout),
          };
        },
      },
    ],
  });
  const resumedExtract = resumedPlan.steps.find((s) => s.stepId === "extract/variants");
  const scored = resumedPlan.steps.find((s) => s.stepId === "score/high-impact");
  assert.deepEqual({ executed: firstPlan.executed, reused: firstPlan.reused }, { executed: 1, reused: 0 });
  assert.deepEqual({ executed: resumedPlan.executed, reused: resumedPlan.reused }, { executed: 1, reused: 1 });
  assert.equal(resumedExtract?.reused, true);
  assert.equal(scored?.reused, false);
  assert.equal(extractExecutions, 1);
  assert.equal(scoreExecutions, 1);
  assert.deepEqual(
    { rows: resumedExtract?.value.rows, artifact_uri: resumedExtract?.value.artifact_uri, backend: resumedExtract?.value.process_backend },
    { rows: 5, artifact_uri: "cas:sha256:variants-fixture", backend: "node-process" },
  );
  assert.equal(scored?.value.process_backend, "node-process");
  assert.equal((await readJobStepCheckpoint(conn, "dogfood-workflow", "score/high-impact"))?.value.candidates, 2);

  let queueTick = 10;
  const queueRunner = queueJobRunner(conn, { clock: () => `2026-07-06T12:01:${String(++queueTick).padStart(2, "0")}.000Z` });
  const queueRunId = "dogfood-queue-cancel";
  const queueCwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-queue-"));
  const queueReplay = {
    schema: "pi-bio.run_replay_spec.v1",
    runId: queueRunId,
    kind: "query",
    sql: "SELECT 1 AS answer",
  };
  await submitBioJob(conn, queueRunner, {
    cwd: queueCwd,
    runId: queueRunId,
    replay: queueReplay,
    now: "2026-07-06T12:01:00.000Z",
    source: "bring-it-home-dogfood",
  });
  const queueClaim = await claimJob(conn, { workerId: "worker:dogfood", now: "2026-07-06T12:01:12.000Z", leaseSeconds: 60 });
  assert.equal(queueClaim?.runId, queueRunId);
  await recordJobClaimStatus(conn, {
    runId: queueRunId,
    workerId: "worker:dogfood",
    attempt: queueClaim.attempt,
    replayDigest: queueClaim.replayDigest,
    phase: "running",
    recordedAt: "2026-07-06T12:01:13.000Z",
    message: "claimed by dogfood worker",
  });
  await cancelBioJob(conn, {
    cwd: queueCwd,
    runId: queueRunId,
    now: "2026-07-06T12:01:14.000Z",
    runner: queueRunner,
    source: "bring-it-home-dogfood",
  });
  let staleQueueWriteRejected = false;
  try {
    await recordJobClaimStatus(conn, {
      runId: queueRunId,
      workerId: "worker:dogfood",
      attempt: queueClaim.attempt,
      replayDigest: queueClaim.replayDigest,
      phase: "succeeded",
      recordedAt: "2026-07-06T12:01:15.000Z",
    });
  } catch {
    staleQueueWriteRejected = true;
  }
  assert.equal(staleQueueWriteRejected, true);
  const resumedQueue = await resumeBioJob(conn, { cwd: queueCwd, runId: queueRunId });
  assert.equal(resumedQueue.phase, "cancelled");

  const profileConn = new FakeDucknngProfileConn();
  const firstProfile = await refreshDucknngHttpProfile(profileConn, {
    profileId: "clinvar-read-dogfood",
    scheme: "https",
    host: "api.example.test",
    port: 443,
    pathPrefix: "/v1/clinvar",
    method: "GET",
    tlsRequired: true,
    authHeaderName: "Authorization",
    authHeaderValue: "Bearer dogfood-token-one",
    expiresAtMs: 1783286600000,
    allowSubjects: ["case:beta", "case:alpha", "case:alpha"],
  });
  const rotatedProfile = await refreshDucknngHttpProfile(profileConn, {
    profileId: "clinvar-read-dogfood",
    scheme: "https",
    host: "api.example.test",
    port: 443,
    pathPrefix: "/v1/clinvar",
    method: "GET",
    tlsRequired: true,
    authHeaderName: "Authorization",
    authHeaderValue: "Bearer dogfood-token-two",
    expiresAtMs: 1783287200000,
    allowSubjects: ["case:alpha", "case:beta"],
  });
  assert.equal(firstProfile.created, true);
  assert.equal(rotatedProfile.created, false);
  assert.equal(rotatedProfile.previous?.policyDigest, firstProfile.current.policyDigest);
  assert.notEqual(rotatedProfile.current.policyDigest, firstProfile.current.policyDigest);
  assert.equal(rotatedProfile.current.version, "2");
  assert.equal(rotatedProfile.current.subjectRestriction.count, 2);
  assert.deepEqual(profileConn.authValuesSeen, ["Bearer dogfood-token-one", "Bearer dogfood-token-two"]);
  assert.doesNotMatch(profileConn.sqlSeen.join("\n"), /dogfood-token|Bearer|case:alpha|case:beta/i);
  const profileReceipt = rotatedProfile.current;
  assert.match(profileReceipt.policyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(profileReceipt), /Bearer|token|secret|case:alpha|case:beta/i);
  await recordObservation(conn, {
    statementKey: `ducknng-profile:${profileReceipt.profileId}`,
    subjectId: `ducknng-profile:${profileReceipt.profileId}`,
    predicate: "ducknng_http_profile_receipt",
    value: profileReceipt,
    recordedAt: NOW,
    source: "bring-it-home-dogfood",
    digest: profileReceipt.policyDigest,
  });

  const hostCapRunCwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-host-cap-"));
  const hostCapCas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-host-cap-cas-")));
  const hostCapRun = await runBioQueryFromManifest({
    cwd: hostCapRunCwd,
    dbPath: ":memory:",
    manifestPath: resolve(process.cwd(), "examples", "variant-counts", "manifest.json"),
    sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    cas: hostCapCas,
    store: conn,
    author: "bring-it-home-dogfood",
    runId: "dogfood-host-capability",
    now: NOW,
    hostCapabilityReceipts: [profileReceipt],
    casMetadata: { conn, nowMs: 1783283000000 },
  });
  assert.equal(hostCapRun.ok, true);
  const replayText = await fs.readFile(join(hostCapRun.runDir, "replay.json"), "utf8");
  const hostCapReplay = JSON.parse(replayText);
  assert.deepEqual(hostCapReplay.hostReceiptDigests, [profileReceipt.policyDigest]);
  assert.doesNotMatch(replayText, /case:alpha|case:beta|Bearer|token|secret/i);
  await assert.rejects(() => reproduceRun({ cwd: hostCapRunCwd, replay: hostCapReplay, cas: hostCapCas }), /hostReceiptDigests/);
  const hostCapReproduced = await reproduceRun({
    cwd: hostCapRunCwd,
    replay: hostCapReplay,
    cas: hostCapCas,
    hostCapabilityReceipts: [profileReceipt],
  });
  assert.equal(hostCapReproduced.matched, true);
  const hostCapCasRefRows = await conn.all(
    `SELECT count(*) AS n
     FROM cas_ref
     WHERE ref_id = ${sqlString(`run:${hostCapRun.runId}`)}
       AND ref_type = 'run'`,
  );
  assert.ok(asNumber(hostCapCasRefRows[0]?.n) >= 3);

  const rEnvRunCwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-r-env-"));
  const rEnvCas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-r-env-cas-")));
  const rEnvManifest = {
    schema: "pi-bio.manifest.v1",
    id: "dogfood-r-env",
    version: "0.1.0",
    title: "Dogfood R environment attestation",
    description: "Tiny R files-only compute step with a declared renv.lock environment descriptor.",
    provides: {
      resolvers: [{ id: "compute.run", version: "0.1.0", title: "Compute run", description: "Run a contained child process.", output: { mode: "table" } }],
      resources: [{
        id: "r_env_artifacts",
        title: "R environment proof artifact",
        kind: "virtual",
        resolver: "compute.run",
        params: {
          table: "r_env_artifacts",
          command: ["Rscript", "-e", "writeLines('renv-attested', 'r-env.txt')"],
          resultTable: "artifacts",
          outputs: [{ name: "r_env", path: "r-env.txt", kind: "file" }],
          environment: renvEnv,
        },
      }],
    },
  };
  const rEnvManifestPath = join(rEnvRunCwd, "manifest.json");
  await fs.writeFile(rEnvManifestPath, JSON.stringify(rEnvManifest), "utf8");
  const rEnvRun = await runBioQueryFromManifest({
    cwd: rEnvRunCwd,
    dbPath: ":memory:",
    manifestPath: rEnvManifestPath,
    resources: ["r_env_artifacts"],
    sql: "SELECT name, kind, digest, size FROM r_env_artifacts",
    compute: { runner: withObservedEnvironment(nodeComputeRunner(), renvEnv) },
    cas: rEnvCas,
    store: conn,
    author: "bring-it-home-dogfood",
    runId: "dogfood-r-env",
    now: "2026-07-06T12:00:04.000Z",
  });
  assert.equal(rEnvRun.ok, true);
  const rEnvRows = JSON.parse(await fs.readFile(join(rEnvRun.runDir, "result.json"), "utf8")).rows;
  assert.deepEqual(rEnvRows.map((r) => [r.name, r.kind]), [["r_env", "file"]]);
  const rEnvReceipts = JSON.parse(await fs.readFile(join(rEnvRun.runDir, "receipts.json"), "utf8"));
  const rEnvProvenance = rEnvReceipts.find((r) => r.resourceId === "r_env_artifacts")?.provenance.find((p) => p.source === "environment");
  assert.ok(rEnvProvenance?.notes?.includes("env_status:matched"), rEnvProvenance?.notes?.join(","));
  assert.ok(rEnvProvenance.notes.includes(`env_declared:${renvEnvDigest}`));
  assert.ok(rEnvProvenance.notes.includes(`env_observed:${renvEnvDigest}`));

  const sessionRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-session-"));
  const sessionCas = fsCasStore(join(sessionRoot, "cas"));
  const sessionPath = join(sessionRoot, "dogfood-session.jsonl");
  const sessionId = "dogfood-session";
  const sessionToolCallId = "call_dogfood|fc_bio_query";
  await fs.writeFile(sessionPath, `${[
    { type: "session", id: sessionId, timestamp: "2026-07-06T12:00:00.000Z", cwd: sessionRoot },
    { type: "message", id: "u1", timestamp: "2026-07-06T12:00:01.000Z", message: { role: "user", content: "Summarize variant consequences." } },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-06T12:00:02.000Z",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-dogfood",
        content: [
          { type: "text", text: "I will query the manifest." },
          { type: "toolCall", id: sessionToolCallId, name: "bio_query", arguments: { sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence" } },
        ],
      },
    },
    { type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-06T12:00:03.000Z", message: { role: "toolResult", toolCallId: sessionToolCallId, toolName: "bio_query", isError: false, content: "3 rows" } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  await ingestSessionJsonl({ conn, cas: sessionCas, sessionPath, sessionId, source: "bring-it-home-dogfood", now: NOW });
  const sessionToolNode = `toolcall:${sessionId}:${sessionToolCallId}`;
  const hostCapRunNode = `run:${hostCapRun.runId}`;
  await recordObservationLink(conn, { subjectId: sessionToolNode, predicate: "executes", objectId: hostCapRunNode, recordedAt: LATER, source: "bring-it-home-dogfood" });
  await recordObservationLink(conn, { subjectId: hostCapRunNode, predicate: "invoked_by", objectId: sessionToolNode, recordedAt: LATER, source: "bring-it-home-dogfood" });
  const figureSvg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><text>variant consequence counts</text></svg>");
  const figureDigest = sha256(figureSvg);
  await hostCapCas.put({ algorithm: "sha256", digest: figureDigest.slice("sha256:".length) }, figureSvg);
  await recordArtifactReference(conn, {
    artifact: {
      digest: figureDigest,
      mediaType: "image/svg+xml",
      semanticRole: "figure",
      sizeBytes: figureSvg.length,
    },
    subjectId: hostCapRunNode,
    predicate: "produces",
    recordedAt: LATER,
    source: "bring-it-home-dogfood",
    attrs: {
      producer_run: hostCapRunNode,
      source_digest: hostCapRun.casRefs.result,
      spec_digest: profileReceipt.policyDigest,
      plotting_system: "inline-svg",
    },
  });

  await conn.run(`
    CREATE TABLE external_kg_raw(subject TEXT, predicate TEXT, object TEXT);
    INSERT INTO external_kg_raw VALUES
      ('MONDO:0004766', 'rdfs:subClassOf', 'MONDO:0004784'),
      ('MONDO:0004784', 'rdfs:subClassOf', 'MONDO:0004979'),
      ('HP:0001250', 'biolink:related_to', 'MONDO:0004766');
  `);
  const externalProjection = await materializeGraphProjectionProfile(conn, {
    schema: "pi-bio.graph_projection_profile.v1",
    id: "dogfood-external-kg",
    title: "Dogfood external KG projection",
    source: { kind: "external_kg", table: "external_kg_raw" },
    columns: { from: "subject", predicate: "predicate", to: "object" },
    closure: { source: "local_cte", transitivePredicates: ["rdfs:subClassOf"] },
    target: { edgesTable: "dogfood_external_edges", closureTable: "dogfood_external_entailed" },
    provenance: [{ source: "scripts/bring-it-home-dogfood.mjs", deid: "not_applicable" }],
  });
  assert.equal(externalProjection.edgeCount, 3);
  assert.equal(externalProjection.closureCount, 3);

  await materializeBioEdgesAsOf(conn, LATER);
  const internalProjection = await materializeGraphProjectionProfile(conn, {
    schema: "pi-bio.graph_projection_profile.v1",
    id: "dogfood-internal-observation-graph",
    title: "Dogfood internal observation graph projection",
    source: { kind: "observations", table: "bio_edges_as_of" },
    columns: { from: "from_id", predicate: "predicate", to: "to_id", attrs: "attrs", trust: "trust" },
    closure: { source: "local_cte", transitivePredicates: ["depends_on"] },
    target: {
      edgesTable: "dogfood_internal_edges",
      closureTable: "dogfood_internal_entailed",
      temporal: { kind: "as_of", asOf: LATER },
    },
    provenance: [{ source: "bio_observations", deid: "unknown" }],
  });
  assert.ok(internalProjection.edgeCount >= 4);
  assert.ok(internalProjection.closureCount >= 3);

  const reportDeps = await conn.all(`
    SELECT to_id FROM dogfood_internal_entailed
    WHERE from_id = 'workflow:dogfood:step:report' AND predicate = 'depends_on'
    ORDER BY to_id
  `);
  assert.deepEqual(reportDeps.map((r) => r.to_id), [
    "workflow:dogfood:step:extract",
    "workflow:dogfood:step:score",
  ]);

  const corpusDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-dogfood-corpus-"));
  const corpus = await exportTrainingCorpusParquet(conn, corpusDir, { asOf: "2026-07-06T12:02:00.000Z" });
  assert.equal(corpus.redaction, "digest_only");
  assert.equal(corpus.tables.sessions.rows, 1);
  assert.equal(corpus.tables.toolCalls.rows, 1);
  assert.equal(corpus.tables.runs.rows, 2);
  assert.equal(corpus.tables.artifacts.rows, 1);
  assert.equal(corpus.tables.hostEvents.rows, 1);
  assert.match(corpus.tables.units.parquetDigest, /^sha256:[0-9a-f]{64}$/);
  const corpusUnitsReadback = await conn.all(
    `SELECT count(*) AS n, max(artifacts) AS artifacts FROM read_parquet(${sqlString(corpus.tables.units.parquetPath)})`,
  );
  assert.equal(asNumber(corpusUnitsReadback[0]?.n), corpus.tables.units.rows);
  assert.equal(asNumber(corpusUnitsReadback[0]?.artifacts), 1);
  const corpusArtifactsReadback = await conn.all(
    `SELECT source_node, semantic_role, plotting_system
     FROM read_parquet(${sqlString(corpus.tables.artifacts.parquetPath)})`,
  );
  assert.deepEqual(corpusArtifactsReadback.map((r) => [r.source_node, r.semantic_role, r.plotting_system]), [
    [hostCapRunNode, "figure", "inline-svg"],
  ]);

  const checkpointRow = await observationAsOfKey(
    conn,
    jobStepCheckpointKey("dogfood-workflow", "extract/variants"),
    "9999-12-31T23:59:59.999Z",
  );
  assert.ok(checkpointRow);

  const counts = await conn.all(`
    SELECT predicate, count(*) AS n
    FROM bio_observations
    GROUP BY predicate
    ORDER BY predicate
  `);
  const summary = {
    dogfood: "bring-it-home",
    hostEventLinks: hostEvent.linkObservationIds.length,
    jobStepExecutions: {
      extract: extractExecutions,
      score: scoreExecutions,
      firstExecuted: firstPlan.executed,
      resumedExecuted: resumedPlan.executed,
      resumedReused: resumedPlan.reused,
      extractReused: resumedExtract?.reused,
      extractBackend: resumedExtract?.value.process_backend,
      scoreBackend: scored?.value.process_backend,
    },
    queueCancel: { runId: queueRunId, staleWriteRejected: staleQueueWriteRejected, resumedPhase: resumedQueue.phase },
    checkpointKey: checkpointRow.statement_key,
    ducknngProfileReceipt: {
      profileId: profileReceipt.profileId,
      policyDigest: profileReceipt.policyDigest,
      rotatedFromDigest: rotatedProfile.previous?.policyDigest,
      version: profileReceipt.version,
      receiptChanged: rotatedProfile.receiptChanged,
      subjectRestriction: profileReceipt.subjectRestriction,
    },
    hostCapabilityRun: {
      runId: hostCapRun.runId,
      hostReceiptDigest: hostCapReplay.hostReceiptDigests[0],
      reproduced: hostCapReproduced.reproduced,
      matched: hostCapReproduced.matched,
      resultMatched: hostCapReproduced.resultMatched,
      casMetadataRefs: asNumber(hostCapCasRefRows[0]?.n),
    },
    renvEnvironment: {
      digest: renvEnvDigest,
      packages: renvEnv.layers.find((l) => l.kind === "package_snapshot")?.packages.length ?? 0,
      rVersion: renvEnv.layers.find((l) => l.kind === "executable" && l.name === "R")?.version ?? null,
      bioconductor: renvEnv.layers.find((l) => l.kind === "module" && l.name === "Bioconductor")?.version ?? null,
      computeRunId: rEnvRun.runId,
      envStatus: "matched",
      artifactRows: rEnvRows.length,
    },
    externalProjection,
    internalProjection,
    trainingCorpus: {
      digest: corpus.digest,
      redaction: corpus.redaction,
      units: corpus.tables.units.rows,
      toolCalls: corpus.tables.toolCalls.rows,
      runs: corpus.tables.runs.rows,
      artifacts: corpus.tables.artifacts.rows,
      hostEvents: corpus.tables.hostEvents.rows,
      parquetReadbackRows: asNumber(corpusUnitsReadback[0]?.n),
      unitsParquetDigest: corpus.tables.units.parquetDigest,
    },
    sdkConsumer,
    observationCounts: Object.fromEntries(counts.map((r) => [r.predicate, asNumber(r.n)])),
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  raw.closeSync?.();
  instance.closeSync?.();
}
