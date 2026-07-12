# Shared temporal memory over DuckNNG


One process owns `bio_observations`; two separate processes use the
unchanged memory SDK through a remote `SqlConn`. The writer appends a
note and the reader recalls the attributed revision. No client opens the
store file.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { createBioObservationSchema } from "../../dist/duckdb/observations.js";
import { resolveDucknngRuntime } from "../../scripts/ducknng-runtime.mjs";

const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const server = await instance.connect();
await server.run(loadSql);
await createBioObservationSchema(duckdbNodeConn(server));
await server.run("SELECT ducknng_start_server('memory', 'tcp://127.0.0.1:0', 2, 134217728, 300000, 0::UBIGINT)");
await server.run("SELECT ducknng_register_exec_method(false)");
const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='memory'")).getRows()[0][0]);

const agentSource = `
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "./dist/duckdb/node-api.js";
import { createDucknngSqlConn } from "./dist/hosts/ducknng-sql-conn.js";
import { remember, recall, listMemory } from "./dist/hosts/memory-store.js";
import { resolveDucknngRuntime } from "./scripts/ducknng-runtime.mjs";
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const raw = await instance.connect();
await raw.run(loadSql);
const conn = createDucknngSqlConn({ client: duckdbNodeConn(raw), url: process.env.MEMORY_URL });
let result;
if (process.env.MEMORY_ACTION === "remember") {
  await remember(conn, {
    slug: "schema-first", kind: "cheatsheet", title: "Schema first", hook: "before composing SQL",
    body: "Inspect declared columns before planning the query.", tags: [],
  }, "2026-07-12T12:00:00Z", "agent:A");
  result = { action: "remembered" };
} else {
  result = { action: "recalled", note: await recall(conn, "schema-first"), all: await listMemory(conn) };
}
process.stdout.write(JSON.stringify({ pid: process.pid, ...result }));
raw.closeSync();
instance.closeSync();
`;
const runAgent = (action) => new Promise((resolveAgent, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", agentSource], {
    cwd: process.cwd(), env: { ...process.env, MEMORY_URL: url, MEMORY_ACTION: action }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveAgent(JSON.parse(stdout)) : reject(new Error(stderr)));
});

const writer = await runAgent("remember");
const reader = await runAgent("recall");
assert.notEqual(writer.pid, reader.pid);
assert.equal(reader.note.author, "agent:A");
assert.equal(reader.note.body, "Inspect declared columns before planning the query.");
assert.deepEqual(reader.all.map((note) => note.slug), ["schema-first"]);
piBio.json({
  pattern: "memory-over-ducknng",
  writer: { action: writer.action },
  reader: { action: reader.action, note: reader.note, slugs: reader.all.map((note) => note.slug) },
});
await server.run("SELECT ducknng_stop_server('memory')");
server.closeSync();
instance.closeSync();
```

<details class="pi-bio-output">

<summary>

JSON output: cell-1
</summary>

``` json
{
  "pattern": "memory-over-ducknng",
  "writer": {
    "action": "remembered"
  },
  "reader": {
    "action": "recalled",
    "note": {
      "slug": "schema-first",
      "kind": "cheatsheet",
      "title": "Schema first",
      "hook": "before composing SQL",
      "body": "Inspect declared columns before planning the query.",
      "tags": [],
      "author": "agent:A"
    },
    "slugs": [
      "schema-first"
    ]
  }
}
```

</details>

This proves sequential cross-process sharing over one temporal ledger.
It is not a concurrent same-slug stress test, an inter-machine
deployment, or evidence that authored memory is a biomedical fact.
