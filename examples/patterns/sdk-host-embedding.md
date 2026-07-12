# Host-neutral SDK embedding


An embedded host supplies SQL, CAS, compute, policy, capability
receipts, and an application-owned resolver through the public
`pi-bio-agent` package. The SDK records the same run evidence used by
CLI and Pi adapters.

``` ts
import assert from "node:assert/strict";
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

const now = "2026-07-12T12:00:00Z";
const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-sdk-qmd-"));
const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-sdk-qmd-cas-")));
const store = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
const policyLog = [];
const sqlPolicy = ({ method, sql }) => {
  policyLog.push({ method, sql });
  if (/secret|token|bearer/i.test(sql)) throw new Error("secret-like SQL rejected by host policy");
};
const hostReceipt = {
  schema: "sdk-host-example.policy.v1",
  policyDigest: `sha256:${"7".repeat(64)}`,
};

const query = await runBioQueryFromManifest({
  cwd,
  dbPath: ":memory:",
  manifestPath: resolve(process.cwd(), "examples/compute-files-only/manifest.json"),
  sql: "SELECT name, kind, digest, size FROM tracks ORDER BY name",
  compute: { runner: nodeComputeRunner() },
  cas,
  store,
  author: "sdk-qmd-host",
  runId: "sdk-host-query",
  now,
  casMetadata: { conn: store, nowMs: Date.parse(now) },
  sqlPolicy,
  hostCapabilityReceipts: [hostReceipt],
});
assert.equal(query.ok, true);
assert.equal(query.result.rows.length, 2);
assert.ok(query.result.rows.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.digest)));

const manifest = {
  schema: "pi-bio.manifest.v1",
  id: "sdk-host-resolver",
  version: "0.1.0",
  title: "SDK host resolver",
  description: "A host-owned resolver bound through the public SDK.",
  provides: {
    resolvers: [{
      id: "sdk.fixture", version: "0.1.0", title: "Fixture", description: "Host fixture relation.",
      output: { mode: "table" },
    }],
    resources: [{
      id: "host_rows", title: "Host rows", kind: "virtual", resolver: "sdk.fixture",
      params: { table: "host_rows", value: "from-sdk-host" },
    }],
    operations: [{
      id: "sdk.host_rows", version: "0.1.0", title: "Read host rows", description: "Read host materialization.",
      transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { readOnly: true, requiredResources: ["host_rows"], sqlTemplate: "SELECT value FROM host_rows" },
    }],
  },
};
const resolver = async (resource, context) => {
  assert.equal(resource.params.table, "host_rows");
  await context.conn.run("CREATE TABLE host_rows AS SELECT ?::VARCHAR AS value", [resource.params.value]);
  return {
    result: { mode: "reference", name: "host_rows", pointer: { uri: "table:host_rows", format: "table" } },
    sourceSnapshots: [{ source: "fixture:sdk-host", version: "fixture-1", retrievedAt: now }],
    provenance: [{ source: "sdk.fixture", retrievedAt: now, notes: ["host_bound_adapter"] }],
  };
};
const operation = await runBioOperationFromManifest({
  cwd,
  dbPath: ":memory:",
  manifestSnapshot: manifest,
  operationId: "sdk.host_rows",
  resolverBindings: { "sdk.fixture": resolver },
  cas,
  store,
  author: "sdk-qmd-host",
  runId: "sdk-host-resolver",
  now,
});
assert.equal(operation.ok, true);
assert.equal(operation.result.rows[0].value, "from-sdk-host");

const queryReplay = JSON.parse(await fs.readFile(join(query.runDir, "replay.json"), "utf8"));
const operationReplay = JSON.parse(await fs.readFile(join(operation.runDir, "replay.json"), "utf8"));
assert.equal(JSON.stringify(operationReplay).includes("resolver =>"), false, "function implementations are not replay data");
const runFacts = await store.all("SELECT subject_id FROM bio_observations WHERE predicate = 'run' ORDER BY subject_id");
assert.equal(runFacts.length, 2);

piBio.json({
  pattern: "sdk-host-embedding",
  hostInjected: ["SqlConn", "CasStore", "ComputeRunner", "sqlPolicy", "hostCapabilityReceipts", "resolverBindings"],
  query: {
    runId: query.runId,
    rows: query.result.rows.map((row) => ({ name: row.name, kind: row.kind, size: Number(row.size) })),
    hostReceiptDigests: queryReplay.hostReceiptDigests,
  },
  customResolver: {
    runId: operation.runId,
    value: operation.result.rows[0].value,
    replayManifestId: operationReplay.manifest.snapshot.id,
  },
  policyStatementsSeen: policyLog.length,
  ledgerRuns: runFacts.map((row) => row.subject_id),
});
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "pattern": "sdk-host-embedding",
  "hostInjected": [
    "SqlConn",
    "CasStore",
    "ComputeRunner",
    "sqlPolicy",
    "hostCapabilityReceipts",
    "resolverBindings"
  ],
  "query": {
    "runId": "sdk-host-query",
    "rows": [
      {
        "name": "regions_bed",
        "kind": "file",
        "size": 66
      },
      {
        "name": "summary",
        "kind": "table",
        "size": 38
      }
    ],
    "hostReceiptDigests": [
      "sha256:7777777777777777777777777777777777777777777777777777777777777777"
    ]
  },
  "customResolver": {
    "runId": "sdk-host-resolver",
    "value": "from-sdk-host",
    "replayManifestId": "sdk-host-resolver"
  },
  "policyStatementsSeen": 14,
  "ledgerRuns": [
    "run:sdk-host-query",
    "run:sdk-host-resolver"
  ]
}
```

</details>

This establishes surface parity through the public SDK. Host functions
are capabilities supplied again at replay; their identities and receipts
are recorded, but executable closures are not serialized into replay
data.
