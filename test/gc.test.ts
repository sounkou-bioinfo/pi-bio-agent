import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGarbage, gcCas, liveDigests, pruneRuns } from "../src/hosts/gc.js";

const D = (n: number) => String(n).padStart(64, "0"); // a fake 64-hex digest

describe("gc: mark-and-sweep over CAS + run retention", () => {
  test("liveDigests pulls every 64-hex digest out of receipt JSON", () => {
    const json = JSON.stringify({ sourceSnapshots: [{ version: `sha256:${D(1)}` }], provenance: [{ digest: `sha256:${D(2)}` }] });
    assert.deepEqual([...liveDigests([json])].sort(), [D(1), D(2)].sort());
  });

  test("gcCas sweeps unreferenced CAS entries, retains the live roots", async () => {
    const casRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    await fs.mkdir(join(casRoot, "sha256"), { recursive: true });
    for (const n of [1, 2, 3]) await fs.writeFile(join(casRoot, "sha256", D(n)), `bytes-${n}`);
    const result = await gcCas(casRoot, new Set([D(1)])); // only D(1) is a live root
    assert.equal(result.retained, 1);
    assert.deepEqual(result.swept.sort(), [`sha256/${D(2)}`, `sha256/${D(3)}`].sort());
    assert.equal(await fs.readFile(join(casRoot, "sha256", D(1)), "utf8"), "bytes-1"); // root survives
    await assert.rejects(() => fs.access(join(casRoot, "sha256", D(2)))); // garbage gone
  });

  test("pruneRuns keeps the newest N", async () => {
    const runs = await fs.mkdtemp(join(tmpdir(), "pi-bio-runs-"));
    for (const n of [1, 2, 3, 4]) {
      const d = join(runs, `run-${n}`);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(join(d, "receipts.json"), "[]");
      await new Promise((r) => setTimeout(r, 8)); // stagger mtimes so newest-first is deterministic
    }
    const { pruned, kept } = await pruneRuns(runs, { keep: 2 });
    assert.deepEqual(kept.sort(), ["run-3", "run-4"].sort()); // newest two kept
    assert.deepEqual(pruned.sort(), ["run-1", "run-2"].sort());
  });

  test("collectGarbage end-to-end: pruned runs' CAS bytes become unreachable and are swept", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-gc-"));
    const runsDir = join(cwd, ".pi", "bio-agent", "runs");
    const casRoot = join(cwd, ".pi", "bio-agent", "cas", "sha256");
    await fs.mkdir(casRoot, { recursive: true });
    // run-old references D(9); run-new references D(8)
    for (const [name, dig] of [["run-old", D(9)], ["run-new", D(8)]] as const) {
      const d = join(runsDir, name);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(join(d, "receipts.json"), JSON.stringify([{ sourceSnapshots: [{ version: `sha256:${dig}` }] }]));
      await fs.writeFile(join(casRoot, dig), "x");
      await new Promise((r) => setTimeout(r, 8));
    }
    const out = await collectGarbage(cwd, { runs: { keep: 1 } }); // keep only run-new
    assert.deepEqual(out.runsPruned, ["run-old"]);
    assert.deepEqual(out.casSwept, [`sha256/${D(9)}`]); // run-old's bytes swept
    assert.equal(await fs.readFile(join(casRoot, D(8)), "utf8"), "x"); // run-new's bytes retained
  });
});
