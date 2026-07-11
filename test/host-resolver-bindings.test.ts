import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeBioManifestFromPath,
  fsCasStore,
  reproduceRun,
  runBioOperationFromManifest,
  runBioQueryFromManifest,
  type BioManifest,
  type BioResolverImpl,
  type RunReplaySpec,
} from "../src/index.js";

const NOW = "2026-07-11T12:00:00.000Z";

const manifest: BioManifest = {
  schema: "pi-bio.manifest.v1",
  id: "host-resolver-binding",
  version: "0.1.0",
  title: "Host resolver binding",
  description: "Exercise app-owned adapters through the high-level host runner.",
  provides: {
    resolvers: [{
      id: "app.fixture",
      version: "0.1.0",
      title: "Application fixture adapter",
      description: "Materialize a host-owned fixture relation.",
      output: { mode: "table" },
    }],
    resources: [{
      id: "app_rows",
      title: "Application rows",
      kind: "virtual",
      resolver: "app.fixture",
      params: { table: "app_rows", value: "from-host" },
    }],
    operations: [{
      id: "app.read",
      version: "0.1.0",
      title: "Read application rows",
      description: "Read the relation materialized by the host adapter.",
      transport: "duckdb.sql",
      inputSchema: { type: "object" },
      sql: {
        readOnly: true,
        requiredResources: ["app_rows"],
        sqlTemplate: "SELECT label FROM app_rows",
      },
    }],
  },
};

const appResolver: BioResolverImpl = async (resource, context) => {
  if (resource.params.table !== "app_rows" || typeof resource.params.value !== "string") {
    throw new Error("app.fixture received an invalid resource contract");
  }
  await context.conn.run("CREATE OR REPLACE TABLE app_rows AS SELECT ?::VARCHAR AS label", [resource.params.value]);
  return {
    result: { mode: "reference", name: "app_rows", pointer: { uri: "table:app_rows", format: "table" } },
    sourceSnapshots: [{ source: "fixture:host-resolver", version: "fixture-1", retrievedAt: context.now ?? NOW }],
    provenance: [{ source: "app.fixture", retrievedAt: context.now ?? NOW, notes: ["host_bound_adapter"] }],
  };
};

test("high-level run, query, describe, and reproduce accept an explicitly bound host resolver", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-host-resolver-"));
  const manifestPath = join(cwd, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const resolverBindings = { "app.fixture": appResolver };
  const cas = fsCasStore(join(cwd, "cas"));

  const description = await describeBioManifestFromPath({ cwd, manifestPath, resolverBindings });
  assert.equal(description.valid, true);
  if (description.valid) assert.equal(description.host.operations[0]?.admission, "ready");

  const operation = await runBioOperationFromManifest({
    cwd,
    dbPath: ":memory:",
    manifestSnapshot: manifest,
    operationId: "app.read",
    runId: "host-resolver-operation",
    now: NOW,
    resolverBindings,
    cas,
  });
  assert.equal(operation.ok, true);
  if (!operation.ok) return;
  assert.deepEqual(operation.result.rows, [{ label: "from-host" }]);

  const query = await runBioQueryFromManifest({
    cwd,
    dbPath: ":memory:",
    manifestSnapshot: manifest,
    sql: "SELECT upper(label) AS label FROM app_rows",
    resources: ["app_rows"],
    runId: "host-resolver-query",
    now: NOW,
    resolverBindings,
  });
  assert.equal(query.ok, true);
  if (query.ok) assert.deepEqual(query.result.rows, [{ label: "FROM-HOST" }]);

  const replay = JSON.parse(await fs.readFile(join(operation.runDir, "replay.json"), "utf8")) as RunReplaySpec;
  const reproduced = await reproduceRun({ cwd, replay, manifestBaseDir: cwd, resolverBindings, cas, now: NOW });
  assert.equal(reproduced.matched, true);
  assert.equal(reproduced.outcomeMatched, true);
});

test("host resolver bindings fail closed when absent or not declared", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-host-resolver-fail-"));
  await assert.rejects(
    () => runBioOperationFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestSnapshot: manifest,
      operationId: "app.read",
      runId: "host-resolver-unbound",
      now: NOW,
    }),
    /no implementation is bound/,
  );

  await assert.rejects(
    () => runBioOperationFromManifest({
      cwd,
      dbPath: ":memory:",
      manifestSnapshot: manifest,
      operationId: "app.read",
      runId: "host-resolver-typo",
      now: NOW,
      resolverBindings: { "app.typo": appResolver },
    }),
    /host resolver binding 'app\.typo' is not declared/,
  );
});
