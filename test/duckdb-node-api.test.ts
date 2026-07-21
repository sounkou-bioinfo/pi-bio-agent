import assert from "node:assert/strict";
import { link, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  assertDuckDbNativeCompatibility,
  duckDbPathsReferToSameFile,
  duckdbNodeConn,
  openDuckDbInstance,
  withDuckDbFileExclusive,
  withDuckDbFileInitialization,
} from "../src/duckdb/node-api.js";
import { assertPortableValueMatrix, readPortableValueMatrix } from "./support/portable-value-matrix.js";

describe("DuckDB native runtime and instance ownership", () => {
  test("rejects a node-api addon executing against another DuckDB core version", () => {
    assert.doesNotThrow(() => assertDuckDbNativeCompatibility(), "the installed package and loaded native core align");
    assert.doesNotThrow(() => assertDuckDbNativeCompatibility("1.5.2-r.2", "v1.5.2"));
    assert.throws(
      () => assertDuckDbNativeCompatibility("1.5.2-r.2", "v1.5.4"),
      /DuckDB native-library mismatch.*align dependencies and restart Pi/,
    );
  });

  test("keeps separate :memory: scientific runs isolated", async () => {
    const first = await openDuckDbInstance(":memory:");
    const second = await openDuckDbInstance(":memory:");
    const firstConn = await first.connect();
    const secondConn = await second.connect();
    try {
      await firstConn.run("CREATE TABLE only_first (value INTEGER)");
      await assert.rejects(() => secondConn.run("SELECT * FROM only_first"), /only_first does not exist/);
    } finally {
      firstConn.closeSync();
      secondConn.closeSync();
      first.closeSync();
      second.closeSync();
    }
  });

  test("collapses dangling file symlinks before the shared target is created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duckdb-node-api-dangling-alias-"));
    const target = join(dir, "future.duckdb");
    const firstAlias = join(dir, "first.duckdb");
    const secondAlias = join(dir, "second.duckdb");
    await symlink(target, firstAlias);
    await symlink(target, secondAlias);
    assert.equal(await duckDbPathsReferToSameFile(firstAlias, secondAlias), true);

    let activeInitializers = 0;
    let maxActiveInitializers = 0;
    await Promise.all([firstAlias, secondAlias].map((path) =>
      withDuckDbFileInitialization(path, async () => {
        activeInitializers += 1;
        maxActiveInitializers = Math.max(maxActiveInitializers, activeInitializers);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeInitializers -= 1;
      }),
    ));
    assert.equal(maxActiveInitializers, 1);

    let activeOwners = 0;
    let maxActiveOwners = 0;
    await Promise.all([firstAlias, secondAlias].map((path) =>
      withDuckDbFileExclusive(path, async () => {
        activeOwners += 1;
        maxActiveOwners = Math.max(maxActiveOwners, activeOwners);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeOwners -= 1;
      }),
    ));
    assert.equal(maxActiveOwners, 1, "isolated scientific owners serialize across aliases");

    const instances = await Promise.all([openDuckDbInstance(firstAlias), openDuckDbInstance(secondAlias)]);
    const connections = await Promise.all(instances.map((instance) => instance.connect()));
    try {
      await connections[0]!.run("CREATE TABLE shared (value INTEGER)");
      await connections[1]!.run("INSERT INTO shared VALUES (1)");
      const result = await connections[0]!.runAndReadAll("SELECT count(*) AS n FROM shared");
      assert.deepEqual(result.getRowObjects(), [{ n: 1n }]);
      let exclusiveBodyRan = false;
      await assert.rejects(
        () => withDuckDbFileExclusive(target, async () => { exclusiveBodyRan = true; }),
        /active cached shared handle/,
      );
      assert.equal(exclusiveBodyRan, false, "ownership conflict fails before scientific execution");
    } finally {
      connections.forEach((connection) => connection.closeSync());
      instances.forEach((instance) => instance.closeSync());
    }

    let releaseExclusive!: () => void;
    let markExclusiveStarted!: () => void;
    const exclusiveStarted = new Promise<void>((resolve) => { markExclusiveStarted = resolve; });
    const exclusiveGate = new Promise<void>((resolve) => { releaseExclusive = resolve; });
    const exclusive = withDuckDbFileExclusive(firstAlias, async () => {
      markExclusiveStarted();
      await exclusiveGate;
    });
    await exclusiveStarted;
    await assert.rejects(() => openDuckDbInstance(secondAlias), /active isolated scientific owner/);
    releaseExclusive();
    await exclusive;
  });

  test("collapses symlink and hard-link aliases into one file cache and initialization lane", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duckdb-node-api-alias-"));
    const real = join(dir, "store.duckdb");
    const seed = await openDuckDbInstance(real);
    const seedConn = await seed.connect();
    await seedConn.run("CREATE TABLE writes (writer INTEGER)");
    seedConn.closeSync();
    seed.closeSync();

    const symlinkPath = join(dir, "store-symlink.duckdb");
    const hardLinkPath = join(dir, "store-hardlink.duckdb");
    await symlink(real, symlinkPath);
    await link(real, hardLinkPath);
    assert.equal(await duckDbPathsReferToSameFile(real, symlinkPath), true);
    assert.equal(await duckDbPathsReferToSameFile(real, hardLinkPath), true);

    let activeInitializers = 0;
    let maxActiveInitializers = 0;
    await Promise.all([real, symlinkPath, hardLinkPath].map((path) =>
      withDuckDbFileInitialization(path, async () => {
        activeInitializers += 1;
        maxActiveInitializers = Math.max(maxActiveInitializers, activeInitializers);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeInitializers -= 1;
      }),
    ));
    assert.equal(maxActiveInitializers, 1, "all aliases serialize bootstrap DDL on one lane");

    const instances = await Promise.all([real, symlinkPath, hardLinkPath].map((path) => openDuckDbInstance(path)));
    const connections = await Promise.all(instances.map((instance) => instance.connect()));
    try {
      await Promise.all(connections.map((connection, writer) => connection.run(`INSERT INTO writes VALUES (${writer})`)));
      const result = await connections[0]!.runAndReadAll("SELECT count(*) AS n FROM writes");
      assert.deepEqual(result.getRowObjects(), [{ n: 3n }]);
    } finally {
      connections.forEach((connection) => connection.closeSync());
      instances.forEach((instance) => instance.closeSync());
    }
  });
});

describe("duckdbNodeConn", () => {
  test("normalizes DuckDB value wrappers into portable SQL-domain shapes", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const row = await readPortableValueMatrix(conn);
      assertPortableValueMatrix(row);
    } finally {
      raw.disconnectSync();
    }
  });

  test("preserves direct null/primitive behavior", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const rows = await conn.all<{ value: string | number | boolean | null | bigint }>("SELECT NULL AS value UNION ALL SELECT 1 AS value");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.value, null);
      assert.equal(rows[1]!.value, 1);
      assert.equal(typeof rows[0]!.value, "object");
      assert.equal(typeof rows[1]!.value, "number");
    } finally {
      raw.disconnectSync();
    }
  });

  test("binds portable bytes, lists, and records using the prepared DuckDB types", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const bytes = new Uint8Array([0, 1, 127, 255]);
      const rows = await conn.all<{
        bytes: Uint8Array;
        values: (number | null)[];
        empty: string[];
        record: { gene: string; score: number };
      }>(
        `SELECT ?::BLOB AS bytes,
                ?::INTEGER[] AS values,
                ?::VARCHAR[] AS empty,
                ?::STRUCT(gene VARCHAR, score DOUBLE) AS record`,
        [bytes, [1, null, 3], [], { gene: "BRCA2", score: 0.75 }],
      );
      assert.deepEqual(Array.from(rows[0]!.bytes), Array.from(bytes));
      assert.deepEqual(rows.map(({ bytes: _bytes, ...row }) => row), [{
        values: [1, null, 3],
        empty: [],
        record: { gene: "BRCA2", score: 0.75 },
      }]);
    } finally {
      raw.disconnectSync();
    }
  });

  test("uses the portable scalar type contract instead of JavaScript integer heuristics", async () => {
    const raw = await (await DuckDBInstance.create(":memory:")).connect();
    try {
      const conn = duckdbNodeConn(raw);
      const rows = await conn.all<{
        number_type: string;
        bigint_type: string;
        null_value: boolean;
        integer_target: number;
      }>(
        "SELECT typeof(?) AS number_type, typeof(?) AS bigint_type, ? IS NULL AS null_value, ?::INTEGER AS integer_target",
        [7, 42n, null, 7],
      );
      assert.deepEqual(rows, [{
        number_type: "DOUBLE",
        bigint_type: "BIGINT",
        null_value: true,
        integer_target: 7,
      }]);
      await assert.rejects(
        () => conn.all("SELECT ? AS value", [{}]),
        /struct parameters cannot be empty/,
      );
    } finally {
      raw.disconnectSync();
    }
  });
});
