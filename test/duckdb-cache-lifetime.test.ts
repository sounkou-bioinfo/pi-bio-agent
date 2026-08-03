import assert from "node:assert/strict";
import { link, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { openDuckDbInstance, withDuckDbFileExclusive } from "../src/duckdb/node-api.js";
import { isBioStoreLocked } from "../src/hosts/bio-store.js";
import { isRunDbOpenError } from "../src/hosts/run-store.js";

describe("cached DuckDB instance lifetime", () => {
  test("closing one shared wrapper leaves the remaining wrapper usable and owned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duckdb-cache-lifetime-"));
    const path = join(dir, "store.duckdb");
    const first = await openDuckDbInstance(path);
    const second = await openDuckDbInstance(path);
    const firstConn = await first.connect();
    const secondConn = await second.connect();
    let firstClosed = false;

    try {
      await firstConn.run("CREATE TABLE shared (value INTEGER)");
      firstConn.closeSync();
      first.closeSync();
      firstClosed = true;

      let exclusiveBodyRan = false;
      let conflict: unknown;
      try {
        await withDuckDbFileExclusive(path, async () => { exclusiveBodyRan = true; });
        assert.fail("expected the remaining cached wrapper to block an isolated owner");
      } catch (error) {
        conflict = error;
      }
      assert.match(conflict instanceof Error ? conflict.message : String(conflict), /active cached shared handle/);
      assert.equal(isBioStoreLocked(conflict), true, "same-process ownership contention is classified like a local store lock");
      assert.equal(isRunDbOpenError(conflict), true, "the pre-run guard is safe for the Pi logger's one unlogged retry");
      assert.equal(exclusiveBodyRan, false, "the remaining cached wrapper retains shared ownership");

      await secondConn.run("INSERT INTO shared VALUES (1)");
      const result = await secondConn.runAndReadAll("SELECT count(*) AS n FROM shared");
      assert.deepEqual(result.getRowObjects(), [{ n: 1n }]);
    } finally {
      if (!firstClosed) {
        firstConn.closeSync();
        first.closeSync();
      }
      secondConn.closeSync();
      second.closeSync();
    }

    let exclusiveBodyRan = false;
    await withDuckDbFileExclusive(path, async () => { exclusiveBodyRan = true; });
    assert.equal(exclusiveBodyRan, true, "the isolated owner is admitted after the last shared wrapper closes");
  });

  test("serializes stale hard-link remapping before concurrent first opens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duckdb-cache-stale-hardlink-"));
    const original = join(dir, "original.duckdb");
    const firstAlias = join(dir, "first-alias.duckdb");
    const secondAlias = join(dir, "second-alias.duckdb");

    const seed = await openDuckDbInstance(original);
    const seedConn = await seed.connect();
    await seedConn.run("CREATE TABLE writes (value INTEGER)");
    seedConn.closeSync();
    seed.closeSync();

    await link(original, firstAlias);
    await link(original, secondAlias);
    await rm(original); // the process map now points at a stale path while the inode survives through both aliases

    const instances = await Promise.all([
      openDuckDbInstance(firstAlias),
      openDuckDbInstance(secondAlias),
    ]);
    const connections = await Promise.all(instances.map((instance) => instance.connect()));
    try {
      await connections[0]!.run("INSERT INTO writes VALUES (1)");
      const result = await connections[1]!.runAndReadAll("SELECT count(*) AS n FROM writes");
      assert.deepEqual(result.getRowObjects(), [{ n: 1n }]);

      let conflict: unknown;
      try {
        await withDuckDbFileExclusive(firstAlias, async () => undefined);
        assert.fail("expected both alias wrappers to retain one shared ownership key");
      } catch (error) {
        conflict = error;
      }
      assert.match(
        conflict instanceof Error ? conflict.message : String(conflict),
        /2 active cached shared handle/,
        "both concurrent aliases must count against one canonical cache owner",
      );
    } finally {
      connections.forEach((connection) => connection.closeSync());
      instances.forEach((instance) => instance.closeSync());
    }
  });
});
