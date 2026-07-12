# Cross-process SQL blackboard


A DuckNNG server owns one `board` table. Four separate Node processes
use the typed remote `SqlConn`; publishing is an `INSERT`, and awaiting
a dependency is a parameterized polling query. The application logic is
in this document.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveDucknngRuntime } from "../../scripts/ducknng-runtime.mjs";

const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const server = await instance.connect();
await server.run(loadSql);
await server.run("CREATE TABLE board (slug TEXT PRIMARY KEY, note JSON)");
await server.run("SELECT ducknng_start_server('board', 'tcp://127.0.0.1:0', 4, 134217728, 300000, 0::UBIGINT)");
await server.run("SELECT ducknng_register_exec_method(false)");
const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='board'")).getRows()[0][0]);

const clientSource = `
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "./dist/duckdb/node-api.js";
import { createDucknngSqlConn } from "./dist/hosts/ducknng-sql-conn.js";
import { resolveDucknngRuntime } from "./scripts/ducknng-runtime.mjs";
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const raw = await instance.connect();
await raw.run(loadSql);
const remote = createDucknngSqlConn({ client: duckdbNodeConn(raw), url: process.env.BOARD_URL });
const deps = JSON.parse(process.env.BOARD_DEPS);
for (const dep of deps) {
  while ((await remote.all("SELECT 1 AS present FROM board WHERE slug = ?", [dep])).length === 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  }
}
const slug = process.env.BOARD_SLUG;
await remote.run("INSERT INTO board VALUES (?, ?)", [slug, JSON.stringify({ slug, dependsOn: deps })]);
process.stdout.write(JSON.stringify({ slug, deps, pid: process.pid }));
raw.closeSync();
instance.closeSync();
`;
const spawnClient = (slug, deps) => new Promise((resolveClient, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", clientSource], {
    cwd: process.cwd(),
    env: { ...process.env, BOARD_URL: url, BOARD_SLUG: slug, BOARD_DEPS: JSON.stringify(deps) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveClient(JSON.parse(stdout)) : reject(new Error(stderr)));
});

const clients = await Promise.all([
  spawnClient("extract", []),
  spawnClient("annotate", ["extract"]),
  spawnClient("qc", ["extract"]),
  spawnClient("classify", ["annotate", "qc"]),
]);
const publicationRows = (await server.runAndReadAll("SELECT rowid, slug, note FROM board ORDER BY rowid")).getRowObjects();
const publicationIndex = new Map(publicationRows.map((row, index) => [row.slug, index]));
const dependencyOrderValid =
  publicationIndex.get("extract") < publicationIndex.get("annotate") &&
  publicationIndex.get("extract") < publicationIndex.get("qc") &&
  publicationIndex.get("annotate") < publicationIndex.get("classify") &&
  publicationIndex.get("qc") < publicationIndex.get("classify");
assert.equal(dependencyOrderValid, true);
assert.equal(new Set(clients.map((client) => client.pid)).size, 4);
const rows = publicationRows
  .map(({ slug, note }) => ({ slug, note }))
  .sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
piBio.json({
  pattern: "cross-process-blackboard",
  clients: clients.map(({ slug, deps }) => ({ slug, deps })),
  dependencyOrderValid,
  rows,
});
await server.run("SELECT ducknng_stop_server('board')");
server.closeSync();
instance.closeSync();
```

<details class="pi-bio-output">

<summary>

JSON output: cell-1
</summary>

``` json
{
  "pattern": "cross-process-blackboard",
  "clients": [
    {
      "slug": "extract",
      "deps": []
    },
    {
      "slug": "annotate",
      "deps": [
        "extract"
      ]
    },
    {
      "slug": "qc",
      "deps": [
        "extract"
      ]
    },
    {
      "slug": "classify",
      "deps": [
        "annotate",
        "qc"
      ]
    }
  ],
  "dependencyOrderValid": true,
  "rows": [
    {
      "slug": "annotate",
      "note": "{\"slug\":\"annotate\",\"dependsOn\":[\"extract\"]}"
    },
    {
      "slug": "classify",
      "note": "{\"slug\":\"classify\",\"dependsOn\":[\"annotate\",\"qc\"]}"
    },
    {
      "slug": "extract",
      "note": "{\"slug\":\"extract\",\"dependsOn\":[]}"
    },
    {
      "slug": "qc",
      "note": "{\"slug\":\"qc\",\"dependsOn\":[\"extract\"]}"
    }
  ]
}
```

</details>

This proves cross-process shared writes and dependency-driven ordering
over one server-owned relation. Authorization, TLS policy, persistence,
and multi-machine deployment remain host responsibilities.
