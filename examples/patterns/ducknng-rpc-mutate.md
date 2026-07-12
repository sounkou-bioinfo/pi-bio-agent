# Cross-process mutable SQL over DuckNNG RPC


The server explicitly registers DuckNNG’s exec method. Separate clients
then perform native DuckDB `INSERT`, `UPDATE`, `DELETE`, and
`ON CONFLICT` statements against one server-owned table.

``` ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveDucknngRuntime } from "../../scripts/ducknng-runtime.mjs";

const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const server = await instance.connect();
await server.run(loadSql);
await server.run("CREATE TABLE shared (k INTEGER PRIMARY KEY, v INTEGER)");
await server.run("INSERT INTO shared VALUES (1, 10), (2, 20)");
await server.run("SELECT ducknng_start_server('mutate', 'tcp://127.0.0.1:0', 1, 134217728, 300000, 0::UBIGINT)");
await server.run("SELECT ducknng_register_exec_method(false)");
const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='mutate'")).getRows()[0][0]);

const clientSource = `
import { DuckDBInstance } from "@duckdb/node-api";
import { resolveDucknngRuntime } from "./scripts/ducknng-runtime.mjs";
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const instance = await DuckDBInstance.create(":memory:", instanceConfig);
const connection = await instance.connect();
await connection.run(loadSql);
const row = (await connection.runAndReadAll(
  "SELECT * FROM ducknng_run_rpc(?, ?, 0::UBIGINT)",
  [process.env.RPC_URL, process.env.RPC_SQL],
)).getRowObjects()[0];
process.stdout.write(JSON.stringify(
  { pid: process.pid, sql: process.env.RPC_SQL, row },
  (_key, value) => typeof value === "bigint" ? Number(value) : value,
));
connection.closeSync();
instance.closeSync();
`;
const mutate = (sql) => new Promise((resolveMutation, reject) => {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", clientSource], {
    cwd: process.cwd(), env: { ...process.env, RPC_URL: url, RPC_SQL: sql }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolveMutation(JSON.parse(stdout)) : reject(new Error(stderr)));
});

const mutations = [];
mutations.push(await mutate("INSERT INTO shared VALUES (3, 30)"));
mutations.push(await mutate("UPDATE shared SET v = 99 WHERE k = 1"));
mutations.push(await mutate("DELETE FROM shared WHERE k = 2"));
mutations.push(await mutate("INSERT INTO shared VALUES (3, 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v"));
const rows = (await server.runAndReadAll("SELECT k, v FROM shared ORDER BY k")).getRowObjects();
assert.deepEqual(rows.map((row) => [Number(row.k), Number(row.v)]), [[1, 99], [3, 5]]);
assert.equal(new Set(mutations.map((mutation) => mutation.pid)).size, 4);
piBio.json({
  pattern: "ducknng-rpc-mutation",
  mutations: mutations.map(({ sql, row }) => ({ sql, row })),
  finalRows: rows,
});
await server.run("SELECT ducknng_stop_server('mutate')");
server.closeSync();
instance.closeSync();
```

<details class="pi-bio-output">

<summary>

JSON output: cell-1
</summary>

``` json
{
  "pattern": "ducknng-rpc-mutation",
  "mutations": [
    {
      "sql": "INSERT INTO shared VALUES (3, 30)",
      "row": {
        "ok": true,
        "error": null,
        "rows_changed": 1,
        "statement_type": 2,
        "result_type": 1
      }
    },
    {
      "sql": "UPDATE shared SET v = 99 WHERE k = 1",
      "row": {
        "ok": true,
        "error": null,
        "rows_changed": 1,
        "statement_type": 3,
        "result_type": 1
      }
    },
    {
      "sql": "DELETE FROM shared WHERE k = 2",
      "row": {
        "ok": true,
        "error": null,
        "rows_changed": 1,
        "statement_type": 5,
        "result_type": 1
      }
    },
    {
      "sql": "INSERT INTO shared VALUES (3, 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      "row": {
        "ok": true,
        "error": null,
        "rows_changed": 1,
        "statement_type": 2,
        "result_type": 1
      }
    }
  ],
  "finalRows": [
    {
      "k": 1,
      "v": 99
    },
    {
      "k": 3,
      "v": 5
    }
  ]
}
```

</details>

The pattern proves native mutable SQL over an explicitly admitted RPC
service. It does not make arbitrary remote SQL safe; the host still owns
method registration, SQL authorization, credentials, and transport
policy.
