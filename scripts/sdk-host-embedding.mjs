import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  duckdbNodeConn,
  fsCasStore,
  nodeComputeRunner,
  runBioQueryFromManifest,
} from "pi-bio-agent";

const NOW = "2026-07-07T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const RUN_ID = "sdk-host-embedding";
const SQL = "SELECT name, kind, digest, size FROM tracks ORDER BY name";

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

console.log(JSON.stringify({
  dogfood: "sdk-host-embedding",
  ok: true,
  publicImport: "pi-bio-agent",
  hostInjected: {
    sqlConn: "duckdbNodeConn",
    casStore: "fsCasStore",
    computeRunner: "nodeComputeRunner",
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
  policy: {
    statementsSeen: policyLog.length,
    sawFinalQuery: policyLog.some((entry) => entry.sql === SQL),
  },
}, null, 2));
