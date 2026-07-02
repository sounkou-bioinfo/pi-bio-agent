import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// LAYERING INVARIANT (public-export hygiene): `core` declares pure contracts/data/validators and must NOT import
// UP into the adapter layers (`../duckdb`, `../hosts`). A leak there pulls a duckdb/host type into `core`'s public
// export surface (pi-bio-agent/core), which is exactly the split the package exports promise. This test scans the
// real source so a future upward import fails the suite instead of silently shipping.
const coreDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "core");
const UPWARD = /from\s+["']\.\.\/(duckdb|hosts)\//;

describe("architecture: core does not import up into adapter layers", () => {
  test("no src/core/*.ts imports from ../duckdb or ../hosts", async () => {
    const files = (await fs.readdir(coreDir)).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = await fs.readFile(join(coreDir, f), "utf8");
      for (const line of src.split("\n")) {
        if (UPWARD.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `core must not depend on ../duckdb or ../hosts (found:\n${offenders.join("\n")})`);
  });
});
