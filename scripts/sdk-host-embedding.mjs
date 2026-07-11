import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  duckdbNodeConn,
  fsCasStore,
  nodeComputeRunner,
  runBioOperationFromManifest,
  runBioQueryFromManifest,
} from "pi-bio-agent";

const NOW = "2026-07-07T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const RUN_ID = "sdk-host-embedding";
const SQL = "SELECT name, kind, digest, size FROM tracks ORDER BY name";
const CUSTOM_MANIFEST = {
  schema: "pi-bio.manifest.v1",
  id: "sdk-host-custom-resolver",
  version: "0.1.0",
  title: "SDK host resolver binding",
  description: "The host supplies an application-owned resolver implementation for this declared operation.",
  provides: {
    resolvers: [{
      id: "sdk.fixture",
      version: "0.1.0",
      title: "SDK fixture resolver",
      description: "Materialize a host-owned fixture relation.",
      output: { mode: "table" },
    }],
    resources: [{
      id: "host_rows",
      title: "Host rows",
      kind: "virtual",
      resolver: "sdk.fixture",
      params: { table: "host_rows", value: "from-sdk-host" },
    }],
    operations: [{
      id: "sdk.host_rows",
      version: "0.1.0",
      title: "Read host rows",
      description: "Read the relation materialized by the app-owned resolver.",
      transport: "duckdb.sql",
      inputSchema: { type: "object" },
      sql: { readOnly: true, requiredResources: ["host_rows"], sqlTemplate: "SELECT value FROM host_rows" },
    }],
  },
};

function asNumber(value) {
  return typeof value === "bigint" ? Number(value) : Number(value ?? 0);
}

async function scalar(conn, sql, params = []) {
  const rows = await conn.all(sql, params);
  return asNumber(Object.values(rows[0] ?? { n: 0 })[0]);
}

const store = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-sdk-host-"));
const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-sdk-host-cas-"));
const cas = fsCasStore(casDir);

const policyLog = [];
const sqlPolicy = ({ method, sql }) => {
  policyLog.push({ method, sql });
  if (/secret|token|bearer/i.test(sql)) throw new Error("sdk-host-embedding: secret-like SQL rejected");
};

const hostReceipt = {
  schema: "sdk-host-embedding.policy.v1",
  policyDigest: `sha256:${"7".repeat(64)}`,
};

const result = await runBioQueryFromManifest({
  cwd,
  dbPath: ":memory:",
  manifestPath: resolve(process.cwd(), "examples", "compute-files-only", "manifest.json"),
  sql: SQL,
  compute: { runner: nodeComputeRunner() },
  cas,
  store,
  author: "sdk-host-embedding",
  runId: RUN_ID,
  now: NOW,
  casMetadata: { conn: store, nowMs: NOW_MS },
  sqlPolicy,
  hostCapabilityReceipts: [hostReceipt],
});

if (!result.ok) {
  throw new Error(`sdk-host-embedding run failed: ${result.error}`);
}

const rows = result.result.rows;
const replay = JSON.parse(await fs.readFile(join(result.runDir, "replay.json"), "utf8"));
const runNode = `run:${result.runId}`;
const casRefCount = await scalar(store, "SELECT count(*) AS n FROM cas_ref WHERE ref_id = ? AND ref_type = 'run'", [runNode]);
const casObjectCount = await scalar(store, "SELECT count(*) AS n FROM cas_object");
const runFactCount = await scalar(store, "SELECT count(*) AS n FROM bio_observations WHERE subject_id = ? AND predicate = 'run'", [runNode]);
const artifactDigestCount = rows.filter((row) => typeof row.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(row.digest)).length;

const customResolver = async (resource, context) => {
  if (resource.params.table !== "host_rows" || typeof resource.params.value !== "string") {
    throw new Error("sdk-host-embedding: invalid custom resolver contract");
  }
  await context.conn.run("CREATE OR REPLACE TABLE host_rows AS SELECT ?::VARCHAR AS value", [resource.params.value]);
  return {
    result: { mode: "reference", name: "host_rows", pointer: { uri: "table:host_rows", format: "table" } },
    sourceSnapshots: [{ source: "fixture:sdk-host-resolver", version: "fixture-1", retrievedAt: NOW }],
    provenance: [{ source: "sdk.fixture", retrievedAt: NOW, notes: ["host_bound_adapter"] }],
  };
};

const custom = await runBioOperationFromManifest({
  cwd,
  dbPath: ":memory:",
  manifestSnapshot: CUSTOM_MANIFEST,
  operationId: "sdk.host_rows",
  resolverBindings: { "sdk.fixture": customResolver },
  cas,
  store,
  author: "sdk-host-embedding",
  runId: "sdk-host-custom-resolver",
  now: NOW,
});
if (!custom.ok) throw new Error(`sdk-host-embedding custom resolver failed: ${custom.error}`);
const customReplay = JSON.parse(await fs.readFile(join(custom.runDir, "replay.json"), "utf8"));

console.log(JSON.stringify({
  pattern: "sdk-host-embedding",
  ok: true,
  publicImport: "pi-bio-agent",
  hostInjected: {
    sqlConn: "duckdbNodeConn",
    casStore: "fsCasStore",
    computeRunner: "nodeComputeRunner",
    resolverBindings: 1,
    sqlPolicy: true,
    hostCapabilityReceipts: 1,
    casMetadata: true,
  },
  run: {
    runId: result.runId,
    rowCount: result.rowCount,
    artifactRows: rows.length,
    artifactDigestCount,
    casRefs: casRefCount,
    casObjects: casObjectCount,
    runFacts: runFactCount,
    hostReceiptDigests: replay.hostReceiptDigests ?? [],
  },
  customResolver: {
    operationId: custom.operationId,
    row: custom.result.rows[0]?.value,
    replayManifestId: customReplay.manifest?.snapshot?.id,
    functionBindingInReplay: JSON.stringify(customReplay).includes("customResolver"),
  },
  policy: {
    statementsSeen: policyLog.length,
    sawFinalQuery: policyLog.some((entry) => entry.sql === SQL),
  },
}, null, 2));
