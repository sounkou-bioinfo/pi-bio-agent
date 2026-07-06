#!/usr/bin/env node
import assert from "node:assert/strict";
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
import { ducknngHttpProfileReceiptFromInfo } from "../dist/duckdb/http-profiles.js";
import { fsCasStore } from "../dist/hosts/fs-cas.js";
import { recordHostEvent } from "../dist/hosts/host-events.js";
import {
  jobStepCheckpointKey,
  readJobStepCheckpoint,
  runJobStepWithCheckpoint,
} from "../dist/hosts/job-store.js";
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
  type HostCapabilityReceipt,
} from "pi-bio-agent";
import {
  validateBioManifest,
  type BioManifest,
  type SqlConn,
} from "pi-bio-agent/core";
import {
  duckdbNodeConn,
  materializeGraphProjectionProfile,
} from "pi-bio-agent/duckdb";
import {
  fsCasStore,
  runJobStepWithCheckpoint,
  type RunQueryRequest,
} from "pi-bio-agent/hosts";

const receipt: HostCapabilityReceipt = { schema: "consumer.policy.v1", policyDigest: "sha256:${"5".repeat(64)}" };
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
  hostCapabilityReceipts: [receipt],
};

void validateBioManifest(manifest);
void request;
void runBioQueryFromManifest;
void recordHostEvent;
void duckdbNodeConn;
void materializeGraphProjectionProfile;
void fsCasStore;
void runJobStepWithCheckpoint;
type _Conn = SqlConn;
`, "utf8");
    await execFileAsync(process.execPath, [
      resolve(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(consumerRoot, "tsconfig.json"),
    ], { cwd: consumerRoot, maxBuffer: 2 * 1024 * 1024 });
    await fs.writeFile(join(consumerRoot, "smoke.mjs"), `
import { runBioQueryFromManifest, recordHostEvent } from "pi-bio-agent";
import { validateBioManifest } from "pi-bio-agent/core";
import { duckdbNodeConn, materializeGraphProjectionProfile } from "pi-bio-agent/duckdb";
import { fsCasStore, runJobStepWithCheckpoint } from "pi-bio-agent/hosts";

for (const [name, value] of Object.entries({
  runBioQueryFromManifest,
  recordHostEvent,
  validateBioManifest,
  duckdbNodeConn,
  materializeGraphProjectionProfile,
  fsCasStore,
  runJobStepWithCheckpoint,
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
  const firstExtract = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "extract/variants",
    recordedAt: "2026-07-06T12:00:01.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 1,
    run: () => {
      extractExecutions += 1;
      return { rows: 5, artifact_uri: "cas:sha256:variants-fixture" };
    },
  });
  const resumedExtract = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "extract/variants",
    recordedAt: "2026-07-06T12:00:02.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 2,
    run: () => {
      extractExecutions += 1;
      return { rows: 99 };
    },
  });
  assert.equal(firstExtract.reused, false);
  assert.equal(resumedExtract.reused, true);
  assert.equal(extractExecutions, 1);
  assert.deepEqual(resumedExtract.value, { rows: 5, artifact_uri: "cas:sha256:variants-fixture" });

  const scored = await runJobStepWithCheckpoint(conn, {
    runId: "dogfood-workflow",
    stepId: "score/high-impact",
    recordedAt: "2026-07-06T12:00:03.000Z",
    source: "bring-it-home-dogfood",
    replayDigest: REPLAY_DIGEST,
    attempt: 1,
    run: () => ({ candidates: 2, upstream_checkpoint: jobStepCheckpointKey("dogfood-workflow", "extract/variants") }),
  });
  assert.equal(scored.reused, false);
  assert.equal((await readJobStepCheckpoint(conn, "dogfood-workflow", "score/high-impact"))?.value.candidates, 2);

  const profileReceipt = ducknngHttpProfileReceiptFromInfo({
    profileId: "clinvar-read-dogfood",
    scheme: "https",
    host: "api.example.test",
    port: 443,
    hasPort: true,
    pathPrefix: "/v1/clinvar",
    method: "GET",
    tlsRequired: true,
    authHeaderNamesJson: "[\"Authorization\"]",
    version: 1n,
    createdMs: 1783283000000n,
    updatedMs: 1783283060000n,
    expiresAtMs: 1783286600000n,
    allowSubjectsJson: "[\"case:alpha\",\"case:beta\"]",
  });
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
    runId: "dogfood-host-capability",
    now: NOW,
    hostCapabilityReceipts: [profileReceipt],
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
  assert.equal(internalProjection.edgeCount, 4);
  assert.equal(internalProjection.closureCount, 3);

  const reportDeps = await conn.all(`
    SELECT to_id FROM dogfood_internal_entailed
    WHERE from_id = 'workflow:dogfood:step:report' AND predicate = 'depends_on'
    ORDER BY to_id
  `);
  assert.deepEqual(reportDeps.map((r) => r.to_id), [
    "workflow:dogfood:step:extract",
    "workflow:dogfood:step:score",
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
    jobStepExecutions: { extract: extractExecutions, extractReused: resumedExtract.reused },
    checkpointKey: checkpointRow.statement_key,
    ducknngProfileReceipt: {
      profileId: profileReceipt.profileId,
      policyDigest: profileReceipt.policyDigest,
      subjectRestriction: profileReceipt.subjectRestriction,
    },
    hostCapabilityRun: {
      runId: hostCapRun.runId,
      hostReceiptDigest: hostCapReplay.hostReceiptDigests[0],
      reproduced: hostCapReproduced.reproduced,
      matched: hostCapReproduced.matched,
      resultMatched: hostCapReproduced.resultMatched,
    },
    externalProjection,
    internalProjection,
    sdkConsumer,
    observationCounts: Object.fromEntries(counts.map((r) => [r.predicate, asNumber(r.n)])),
  };
  console.log(JSON.stringify(summary, null, 2));
} finally {
  raw.closeSync?.();
  instance.closeSync?.();
}
