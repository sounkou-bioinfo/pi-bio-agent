# CAS bytes with SQL metadata over DuckNNG


This research pattern composes a mutable metadata tree served over
DuckNNG RPC with immutable content-addressed bytes. It exercises
filesystem-like semantics without claiming a FUSE implementation or a
production distributed filesystem.

``` ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { createDucknngSqlConn } from "../../dist/hosts/ducknng-sql-conn.js";
import { resolveDucknngRuntime } from "../../scripts/ducknng-runtime.mjs";

const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-ducknng-fs-"));
const { instanceConfig, loadSql } = await resolveDucknngRuntime();
const put = async (bytes) => {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const path = join(casDir, digest.replace(":", "_"));
  await fs.writeFile(path, bytes, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { digest, size: bytes.length };
};

const serverInstance = await DuckDBInstance.create(":memory:", instanceConfig);
const server = await serverInstance.connect();
const clientInstance = await DuckDBInstance.create(":memory:", instanceConfig);
const client = await clientInstance.connect();
try {
  await server.run(loadSql);
  await server.run("CREATE SEQUENCE fs_seq START 2");
  await server.run("CREATE TABLE fs_node (id BIGINT PRIMARY KEY, parent_id BIGINT, name TEXT, kind TEXT, digest TEXT, size BIGINT)");
  await server.run("INSERT INTO fs_node VALUES (1, NULL, '/', 'dir', NULL, NULL)");
  await server.run("SELECT ducknng_start_server('fs', 'tcp://127.0.0.1:0', 2, 134217728, 300000, 0::UBIGINT)");
  await server.run("SELECT ducknng_register_exec_method(false)");
  const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='fs'")).getRows()[0][0]);

  await client.run(loadSql);
  const remote = createDucknngSqlConn({ client: duckdbNodeConn(client), url });
  const resolvePath = async (path) => {
    let id = 1;
    for (const part of path.split("/").filter(Boolean)) {
      const rows = await remote.all("SELECT id FROM fs_node WHERE parent_id = ? AND name = ?", [id, part]);
      assert.equal(rows.length, 1, `missing path ${path}`);
      id = Number(rows[0].id);
    }
    return id;
  };
  const parentAndName = (path) => {
    const parts = path.split("/").filter(Boolean);
    return { parent: `/${parts.slice(0, -1).join("/")}`, name: parts.at(-1) };
  };
  const mkdir = async (path) => {
    const { parent, name } = parentAndName(path);
    await remote.run("INSERT INTO fs_node SELECT nextval('fs_seq'), ?, ?, 'dir', NULL, NULL", [await resolvePath(parent), name]);
  };
  const write = async (path, content) => {
    const object = await put(Buffer.from(content));
    const { parent, name } = parentAndName(path);
    const parentId = await resolvePath(parent);
    await remote.run("DELETE FROM fs_node WHERE parent_id = ? AND name = ?", [parentId, name]);
    await remote.run("INSERT INTO fs_node SELECT nextval('fs_seq'), ?, ?, 'file', ?, ?", [parentId, name, object.digest, object.size]);
  };
  const tree = () => remote.all(`WITH RECURSIVE walk(id, path, kind, digest, size) AS (
    SELECT id, '', kind, digest, size FROM fs_node WHERE id = 1
    UNION ALL
    SELECT node.id, walk.path || '/' || node.name, node.kind, node.digest, node.size
    FROM fs_node node JOIN walk ON node.parent_id = walk.id
  ) SELECT path, kind, digest, size FROM walk WHERE id <> 1 ORDER BY path`);

  await mkdir("/data");
  await mkdir("/data/sub");
  await write("/data/a.txt", "hello");
  await write("/data/sub/b.txt", "hello");
  await write("/data/c.txt", "world");
  const before = await tree();
  assert.equal((await fs.readdir(casDir)).length, 2, "equal bytes must deduplicate");

  const cId = await resolvePath("/data/c.txt");
  await remote.run("UPDATE fs_node SET parent_id = ?, name = 'c.txt' WHERE id = ?", [await resolvePath("/data/sub"), cId]);
  const moved = await tree();
  const subId = await resolvePath("/data/sub");
  await remote.run(`DELETE FROM fs_node WHERE id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT ?::BIGINT UNION ALL SELECT node.id FROM fs_node node JOIN descendants parent ON node.parent_id = parent.id
    ) SELECT id FROM descendants
  )`, [subId]);
  const after = await tree();

  assert.ok(moved.some((row) => row.path === "/data/sub/c.txt"));
  assert.deepEqual(after.map((row) => row.path), ["/data", "/data/a.txt"]);
  piBio.json({
    pattern: "cas-plus-rpc-metadata",
    casObjectsForThreeFiles: 2,
    before,
    afterMove: moved,
    afterRecursiveDelete: after,
  });
  await server.run("SELECT ducknng_stop_server('fs')");
} finally {
  client.closeSync();
  clientInstance.closeSync();
  server.closeSync();
  serverInstance.closeSync();
  await fs.rm(casDir, { recursive: true, force: true });
}
```

<details class="pi-bio-output">

<summary>

JSON output: cell-1
</summary>

``` json
{
  "pattern": "cas-plus-rpc-metadata",
  "casObjectsForThreeFiles": 2,
  "before": [
    {
      "path": "/data",
      "kind": "dir",
      "digest": null,
      "size": null
    },
    {
      "path": "/data/a.txt",
      "kind": "file",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": "5n"
    },
    {
      "path": "/data/c.txt",
      "kind": "file",
      "digest": "sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
      "size": "5n"
    },
    {
      "path": "/data/sub",
      "kind": "dir",
      "digest": null,
      "size": null
    },
    {
      "path": "/data/sub/b.txt",
      "kind": "file",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": "5n"
    }
  ],
  "afterMove": [
    {
      "path": "/data",
      "kind": "dir",
      "digest": null,
      "size": null
    },
    {
      "path": "/data/a.txt",
      "kind": "file",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": "5n"
    },
    {
      "path": "/data/sub",
      "kind": "dir",
      "digest": null,
      "size": null
    },
    {
      "path": "/data/sub/b.txt",
      "kind": "file",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": "5n"
    },
    {
      "path": "/data/sub/c.txt",
      "kind": "file",
      "digest": "sha256:486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7",
      "size": "5n"
    }
  ],
  "afterRecursiveDelete": [
    {
      "path": "/data",
      "kind": "dir",
      "digest": null,
      "size": null
    },
    {
      "path": "/data/a.txt",
      "kind": "file",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": "5n"
    }
  ]
}
```

</details>

The example proves composability of mutable SQL metadata and immutable
CAS bytes. FUSE, authorization policy, remote CAS transport, crash
recovery, and production filesystem semantics remain host/application
work.
