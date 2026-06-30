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

  test("distributed safety: minAgeMs grace retains too-new unrooted entries (the write race)", async () => {
    const casRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    await fs.mkdir(join(casRoot, "sha256"), { recursive: true });
    await fs.writeFile(join(casRoot, "sha256", D(2)), "just-written-by-an-in-flight-run"); // unrooted, but brand new
    // with a 60s grace, a freshly-written unrooted entry is NOT swept (a concurrent/remote writer may own it)
    const result = await gcCas(casRoot, new Set(), { minAgeMs: 60_000 });
    assert.deepEqual(result.swept, [], "a too-new entry is retained despite being unrooted");
    assert.equal(await fs.readFile(join(casRoot, "sha256", D(2)), "utf8"), "just-written-by-an-in-flight-run");
  });

  test("distributed safety: extraRoots (another node's live digests) protect shared-CAS bytes", async () => {
    const casRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    await fs.mkdir(join(casRoot, "sha256"), { recursive: true });
    for (const n of [1, 2]) await fs.writeFile(join(casRoot, "sha256", D(n)), `b-${n}`);
    // D(1) is referenced only by a REMOTE node (not in any local receipt) -> must survive when passed as a root
    const result = await gcCas(casRoot, new Set([D(1)]));
    assert.deepEqual(result.swept, [`sha256/${D(2)}`], "only the truly-unrooted entry is swept");
    assert.equal(await fs.readFile(join(casRoot, "sha256", D(1)), "utf8"), "b-1", "the remote node's referenced bytes survive");
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

  test("casMode 'shared' FAILS CLOSED without the complete cross-writer root set (an advertised distributed knob must refuse, not corrupt)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-gc-"));
    // shared CAS + no extraRoots/rootsProvider -> a local sweep could delete another writer's bytes -> refuse
    await assert.rejects(() => collectGarbage(cwd, { casMode: "shared", minAgeMs: 60_000 }), /complete cross-writer root set/);
    // shared CAS + roots but no write-race grace -> still refuse
    await assert.rejects(() => collectGarbage(cwd, { casMode: "shared", extraRoots: [D(1)] }), /positive minAgeMs/);
  });

  test("casMode 'shared' (receipt-scan path) runs once given the complete roots + grace; rootsProvider roots protect a remote writer's bytes", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-gc-"));
    const casRoot = join(cwd, ".pi", "bio-agent", "cas", "sha256");
    await fs.mkdir(casRoot, { recursive: true });
    // D(7) is referenced only by ANOTHER writer (no local receipt). It must survive when supplied as a cross-writer root.
    await fs.writeFile(join(casRoot, D(7)), "remote-writers-live-bytes");
    await fs.writeFile(join(casRoot, D(6)), "truly-unrooted-garbage");
    await new Promise((r) => setTimeout(r, 25)); // age both entries well past the 1ms write-race grace
    const out = await collectGarbage(cwd, { casMode: "shared", rootsProvider: async () => [D(7)], minAgeMs: 1 });
    assert.deepEqual(out.casSwept, [`sha256/${D(6)}`], "the unrooted entry is swept; the remote-rooted one is not");
    assert.equal(await fs.readFile(join(casRoot, D(7)), "utf8"), "remote-writers-live-bytes", "the remote writer's rooted bytes survive");
    await assert.rejects(() => fs.access(join(casRoot, D(6))), "garbage gone");
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
