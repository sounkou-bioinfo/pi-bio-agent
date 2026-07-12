# Method selection and skill authoring


This is the smallest executable application surface for the
method-selection problem described in the LinkedIn exchange: given a
question, a dataset, and host constraints, select a suitable method,
compose it, test it, and retain the approved result. The catalog below
is deliberately refreshable application data. The durable artifact is
the selected composition and its evidence, not a permanently maintained
list of every available bioinformatics tool.

## Study the action space

The study phase receives method descriptions and current host
constraints. It uses SQL over the declared catalog to select a
candidate. The actor is free to author the next manifest from that
candidate; no core code knows what a variant summary is. This path is
deliberately model-light: a weaker host only needs to inspect schemas,
compose a bounded selection query, and carry the selected contract
forward. The dataset and catalog remain in DuckDB rather than being
serialized into the model context.

``` ts
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  duckdbNodeConn,
  fsCasStore,
  openBioStore,
  runBioOperationFromManifest,
  runBioQueryFromManifest,
  submitCandidateForApproval,
  decideCandidateApproval,
  recordSkill,
  recallSkill,
  materializeBioEdgesAsOf,
} from "pi-bio-agent";

const now = {
  discover: "2026-07-12T14:00:00Z",
  select: "2026-07-12T14:01:00Z",
  execute: "2026-07-12T14:02:00Z",
  approve: "2026-07-12T14:03:00Z",
};
const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-method-selection-"));
const cas = fsCasStore(join(workspace, "cas"));
const ledger = await openBioStore(workspace, { path: join(workspace, "ledger.duckdb") });
const variantCsv = await fs.readFile("examples/variant-counts/data/variants.csv");
await fs.writeFile(join(workspace, "variants.csv"), variantCsv);

// In production this is refreshed from tool documentation, registries, and environment probes. It is not a
// maintained copy of the whole ecosystem. The output contract is explicit because selection without an output shape
// only chooses names, not executable science.
const actionCatalog = [
  {
    id: "variant.summary.sql",
    title: "DuckDB consequence summary",
    description: "Count variants by consequence in a declared variant table.",
    objective: "variant_summary",
    dataset_kind: "variant_table",
    execution_kind: "duckdb.sql",
    requires_compute: false,
    requires_network: false,
    read_only: true,
    output_kind: "relation",
    sql_template: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    source: "catalog:fixture",
  },
  {
    id: "variant.summary.python",
    title: "Python consequence summary",
    description: "Count variants by consequence with a Python dataframe program.",
    objective: "variant_summary",
    dataset_kind: "variant_table",
    execution_kind: "compute.run",
    requires_compute: true,
    requires_network: false,
    read_only: true,
    output_kind: "relation",
    sql_template: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    source: "catalog:fixture",
  },
  {
    id: "variant.annotation.remote",
    title: "Remote variant annotation",
    description: "Annotate variants through a live external service.",
    objective: "variant_summary",
    dataset_kind: "variant_table",
    execution_kind: "ducknng.http_fanout",
    requires_compute: false,
    requires_network: true,
    read_only: true,
    output_kind: "relation",
    sql_template: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    source: "catalog:fixture",
  },
];
await fs.writeFile(join(workspace, "actions.json"), JSON.stringify(actionCatalog, null, 2));

const baseManifest = {
  schema: "pi-bio.manifest.v1",
  id: "method-selection-study",
  version: "0.1.0",
  title: "Method selection study",
  description: "Refreshable action descriptions and a local variant dataset.",
  provides: {
    resolvers: [{
      id: "duckdb.file_scan",
      version: "0.1.0",
      title: "DuckDB file scan",
      description: "Materialize a DuckDB-readable local file.",
      output: { mode: "table" },
    }],
    resources: [
      { id: "actions", title: "Refreshable method descriptions", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "actions.json", table: "actions" } },
      { id: "variants", title: "Variant dataset", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "variants.csv", table: "variants" } },
    ],
  },
};

const runQuery = (sql, resources, runId, recordedAt) => runBioQueryFromManifest({
  cwd: workspace,
  dbPath: ":memory:",
  manifestSnapshot: baseManifest,
  manifestBaseDir: workspace,
  sql,
  resources,
  runId,
  now: recordedAt,
  store: ledger.conn,
  author: "agent:method-study",
  cas,
});

const actionSchema = await runQuery("DESCRIBE actions", ["actions"], "method-study-schema", now.discover);
const datasetSummary = await runQuery("SUMMARIZE variants", ["variants"], "method-study-dataset", now.discover);
assert.equal(actionSchema.ok, true);
assert.equal(datasetSummary.ok, true);

const question = "Summarize the consequences in this variant table";
const hostConstraints = { compute: false, network: false, writable: false };
const selection = await runQuery(
  `SELECT id, title, description, execution_kind, output_kind, sql_template
   FROM actions
   WHERE objective = 'variant_summary'
     AND dataset_kind = 'variant_table'
     AND requires_compute = ${hostConstraints.compute ? "true" : "false"}
     AND requires_network = ${hostConstraints.network ? "true" : "false"}
     AND read_only = ${hostConstraints.writable ? "false" : "true"}
   ORDER BY id
   LIMIT 1`,
  ["actions"],
  "method-study-select",
  now.select,
);
assert.equal(selection.ok, true);
assert.equal(selection.result.rows.length, 1);
const selected = selection.result.rows[0];
assert.equal(selected.id, "variant.summary.sql");

piBio.json({
  study: { question, hostConstraints },
  discovery: {
    actionColumns: actionSchema.result.rows.map((row) => row.column_name),
    datasetColumns: datasetSummary.result.rows.map((row) => row.column_name),
  },
  selectedAction: { id: selected.id, title: selected.title, executionKind: selected.execution_kind, outputKind: selected.output_kind },
});
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "study": {
    "question": "Summarize the consequences in this variant table",
    "hostConstraints": {
      "compute": false,
      "network": false,
      "writable": false
    }
  },
  "discovery": {
    "actionColumns": [
      "id",
      "title",
      "description",
      "objective",
      "dataset_kind",
      "execution_kind",
      "requires_compute",
      "requires_network",
      "read_only",
      "output_kind",
      "sql_template",
      "source"
    ],
    "datasetColumns": [
      "variant_key",
      "consequence",
      "allele_frequency"
    ]
  },
  "selectedAction": {
    "id": "variant.summary.sql",
    "title": "DuckDB consequence summary",
    "executionKind": "duckdb.sql",
    "outputKind": "relation"
  }
}
```

</details>

## Author, test, and activate the composition

The selected row becomes a new manifest operation. The candidate is
executed through the normal run path, tested against an isolated
fixture, parked for approval, and then activated. The approved method is
materialized as a skill revision in the same temporal observation
ledger; it is not copied into a second memory system.

``` ts
const selectedManifest = {
  ...baseManifest,
  id: "method-selection-approved",
  version: "0.1.0",
  title: selected.title,
  description: selected.description,
  provides: {
    ...baseManifest.provides,
    operations: [{
      id: selected.id,
      version: "0.1.0",
      title: selected.title,
      description: selected.description,
      transport: "duckdb.sql",
      inputSchema: { type: "object" },
      outputSchema: { type: "array", items: { type: "object" } },
      sql: { readOnly: true, requiredResources: ["variants"], sqlTemplate: selected.sql_template },
    }],
  },
};

const operation = await runBioOperationFromManifest({
  cwd: workspace,
  dbPath: ":memory:",
  manifestSnapshot: selectedManifest,
  manifestBaseDir: workspace,
  operationId: selected.id,
  runId: "method-study-selected-operation",
  now: now.execute,
  store: ledger.conn,
  author: "agent:method-study",
  cas,
});
assert.equal(operation.ok, true);
const resultRows = operation.result.rows.map((row) => ({ consequence: row.consequence, n: Number(row.n) }));
assert.deepEqual(resultRows, [
  { consequence: "missense", n: 2 },
  { consequence: "stop_gained", n: 2 },
  { consequence: "synonymous", n: 1 },
]);

const fixtureSql = [
  "CREATE TABLE variants (variant_key VARCHAR, consequence VARCHAR, allele_frequency DOUBLE)",
  "INSERT INTO variants VALUES ('1:1000:C:T', 'stop_gained', 0.0003), ('2:2000:G:A', 'missense', 0.3), ('3:3000:A:G', 'stop_gained', NULL), ('4:4000:T:C', 'missense', 0.01), ('5:5000:G:C', 'synonymous', 0.2)",
].join(";");
const candidate = {
  id: selected.id,
  version: "0.1.0",
  fixtureSql,
  sql: selected.sql_template,
  expected: resultRows,
};
const sandboxInstance = await DuckDBInstance.create(":memory:");
const sandbox = duckdbNodeConn(await sandboxInstance.connect());
const parked = await submitCandidateForApproval(ledger.conn, candidate, {
  sandbox,
  recordedAt: now.execute,
  source: "agent:method-study",
});
assert.deepEqual({ validation: parked.validation, test: parked.test, pending: parked.pendingApproval }, {
  validation: "passed",
  test: "passed",
  pending: true,
});
const activated = await decideCandidateApproval(ledger.conn, {
  id: selected.id,
  version: "0.1.0",
  specDigest: parked.specDigest,
  approved: true,
  decidedAt: now.approve,
  source: "review:method-study",
  approvedBy: "review:method-study",
  reason: "read-only SQL action matched the declared output contract on the fixture",
});
assert.equal(activated.activated, true);

const skillName = "method-selection-variant-summary";
await recordSkill(ledger.conn, {
  name: skillName,
  description: "Use the approved variant consequence summary composition.",
  body: JSON.stringify({ manifest: selectedManifest, operationId: selected.id, specDigest: parked.specDigest }),
}, now.approve, "agent:method-study");
const skill = await recallSkill(ledger.conn, skillName);
assert.ok(skill);
assert.ok(skill.body.includes(selected.id));

await materializeBioEdgesAsOf(ledger.conn, "9999-12-31T23:59:59.999Z");
const graph = await ledger.conn.all(
  "SELECT from_id, predicate, to_id FROM bio_edges_as_of WHERE from_id LIKE 'run:%' OR from_id LIKE 'operation:%' ORDER BY from_id, predicate, to_id LIMIT 20",
);
const observations = await ledger.conn.all(
  "SELECT subject_id, predicate FROM bio_observations WHERE subject_id LIKE 'candidate:%' OR subject_id = ? ORDER BY subject_id, predicate",
  [`operation:${selected.id}`],
);

piBio.json({
  authoredManifest: { id: selectedManifest.id, operationId: selected.id, resources: selectedManifest.provides.resources.map((resource) => resource.id) },
  run: { runId: operation.runId, rows: resultRows, resultPinned: Boolean(operation.casRefs?.result) },
  candidate: { specDigest: parked.specDigest, validation: parked.validation, test: parked.test, activated: activated.activated },
  skillRevision: { name: skill.name, author: skill.author, containsApprovedOperation: skill.body.includes(selected.id) },
  ledger: { observations, graph },
});

sandbox.closeSync?.();
sandboxInstance.closeSync();
ledger.close();
```

<details class="pi-bio-output">

<summary>

Output: cell-2
</summary>

``` json
{
  "authoredManifest": {
    "id": "method-selection-approved",
    "operationId": "variant.summary.sql",
    "resources": [
      "actions",
      "variants"
    ]
  },
  "run": {
    "runId": "method-study-selected-operation",
    "rows": [
      {
        "consequence": "missense",
        "n": 2
      },
      {
        "consequence": "stop_gained",
        "n": 2
      },
      {
        "consequence": "synonymous",
        "n": 1
      }
    ],
    "resultPinned": true
  },
  "candidate": {
    "specDigest": "sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
    "validation": "passed",
    "test": "passed",
    "activated": true
  },
  "skillRevision": {
    "name": "method-selection-variant-summary",
    "author": "agent:method-study",
    "containsApprovedOperation": true
  },
  "ledger": {
    "observations": [
      {
        "subject_id": "candidate:sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
        "predicate": "harness:approval_status"
      },
      {
        "subject_id": "candidate:sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
        "predicate": "harness:approval_status"
      },
      {
        "subject_id": "candidate:sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
        "predicate": "harness:candidate_identity"
      },
      {
        "subject_id": "candidate:sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
        "predicate": "harness:test_status"
      },
      {
        "subject_id": "candidate:sha256:7ce58ebfa30984ec593a0042e81e0e0c5fa74387d73644fe4ce0e133f22bc987",
        "predicate": "harness:validation_status"
      },
      {
        "subject_id": "operation:variant.summary.sql",
        "predicate": "harness:active_version"
      }
    ],
    "graph": [
      {
        "from_id": "operation:method-selection-approved@0.1.0:variant.summary.sql@0.1.0",
        "predicate": "requires",
        "to_id": "resource:method-selection-approved@0.1.0:variants"
      },
      {
        "from_id": "operation:variant.summary.sql",
        "predicate": "harness:active_version",
        "to_id": "operation:variant.summary.sql@0.1.0"
      },
      {
        "from_id": "run:method-study-dataset",
        "predicate": "uses_manifest",
        "to_id": "manifest:method-selection-study@0.1.0"
      },
      {
        "from_id": "run:method-study-dataset",
        "predicate": "uses_resource",
        "to_id": "resource:method-selection-study@0.1.0:variants"
      },
      {
        "from_id": "run:method-study-schema",
        "predicate": "uses_manifest",
        "to_id": "manifest:method-selection-study@0.1.0"
      },
      {
        "from_id": "run:method-study-schema",
        "predicate": "uses_resource",
        "to_id": "resource:method-selection-study@0.1.0:actions"
      },
      {
        "from_id": "run:method-study-select",
        "predicate": "uses_manifest",
        "to_id": "manifest:method-selection-study@0.1.0"
      },
      {
        "from_id": "run:method-study-select",
        "predicate": "uses_resource",
        "to_id": "resource:method-selection-study@0.1.0:actions"
      },
      {
        "from_id": "run:method-study-selected-operation",
        "predicate": "executes_operation",
        "to_id": "operation:method-selection-approved@0.1.0:variant.summary.sql@0.1.0"
      },
      {
        "from_id": "run:method-study-selected-operation",
        "predicate": "uses_manifest",
        "to_id": "manifest:method-selection-approved@0.1.0"
      }
    ]
  }
}
```

</details>

The application establishes the method-selection mechanics, not
universal tool quality. It is model-agnostic and can be driven by a
skill-only CLI host or a weaker agent because the facts and selection
state stay in relations. Its external catalog can be replaced without
changing the substrate; only the selected, tested composition becomes
durable. DuckDB is already the stateful work surface here: the action
and dataset relations stay outside the agent context while SQL performs
bounded discovery and reduction. A larger application may add live
documentation, richer output schemas, competing candidates, human
review, or a persistent NNG/embedded runtime for methods that need
process-local state while keeping this same evidence path.
