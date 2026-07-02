import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// LAYERING INVARIANT (public-export hygiene): `core` declares pure contracts/data/validators and must NOT import
// UP into the adapter layers (`../duckdb`, `../hosts`). A leak there pulls a duckdb/host type into `core`'s public
// export surface (pi-bio-agent/core), which is exactly the split the package exports promise. This test scans the
// real source so a future upward import fails the suite instead of silently shipping.
const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

async function importOffenders(layerDir: string, forbidden: RegExp): Promise<string[]> {
  const dir = join(srcDir, layerDir);
  const offenders: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      if (!ent.name.endsWith(".ts")) continue;
      const src = await fs.readFile(full, "utf8");
      for (const line of src.split("\n")) if (forbidden.test(line)) offenders.push(`${full.slice(srcDir.length + 1)}: ${line.trim()}`);
    }
  };
  await walk(dir);
  return offenders;
}

// The layer order is hosts → duckdb → core (hosts composes duckdb resolvers/adapters; duckdb adapts core; core is
// pure contracts). Imports may only point DOWN. Locking both edges keeps the public package exports (./core,
// ./duckdb, ./hosts) honest and stops a "just import the helper from hosts" shortcut from reversing the direction.
describe("architecture: layer imports only point downward (hosts → duckdb → core)", () => {
  test("core imports neither ../duckdb nor ../hosts", async () => {
    assert.deepEqual(await importOffenders("core", /from\s+["']\.\.\/(duckdb|hosts)\//), []);
  });

  test("duckdb does not import UP into ../hosts", async () => {
    assert.deepEqual(await importOffenders("duckdb", /from\s+["'](\.\.\/)+hosts\//), []);
  });
});
