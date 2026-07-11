import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// Pattern + anti-rot gate for the user guide: extract the EXACT manifest + CSV from docs/guide.md and run
// them end to end. If someone edits the guide's example into something that does not validate or run, this
// fails — the published walkthrough cannot rot, the same contract as the docs-index / README gates.

async function guideBlocks(): Promise<Array<{ lang: string; body: string }>> {
  const guide = await fs.readFile("docs/guide.md", "utf8");
  return [...guide.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, body: m[2]! }));
}

describe("user guide example runs end to end (anti-rot gate)", () => {
  test("the guide's resource-only manifest + CSV produce the counts it claims (via bio_query)", async () => {
    const blocks = await guideBlocks();
    const manifestBlock = blocks.find((b) => b.lang === "json" && b.body.includes('"pi-bio.manifest.v1"'));
    const csvBlock = blocks.find((b) => b.lang === "csv");
    assert.ok(manifestBlock, "guide must contain a manifest JSON block");
    assert.ok(csvBlock, "guide must contain the example CSV block");
    const manifest = JSON.parse(manifestBlock.body); // must be valid JSON

    const cwd = await fs.mkdtemp(join(tmpdir(), "guide-"));
    await fs.mkdir(join(cwd, "data"), { recursive: true });
    await fs.writeFile(join(cwd, "data", "variants.csv"), csvBlock.body, "utf8");
    await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest), "utf8");

    // the manifest declares only the resource — the query (the guide's §2 SQL) is the agent's, run ad hoc
    const res = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: "manifest.json", runId: "guide-1", now: "2026-06-29T00:00:00Z",
      sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");

    // the guide's CSV: stop_gained x2, missense x1
    assert.deepEqual(res.result.rows.map((r) => [r.consequence, Number(r.n)]), [
      ["missense", 1],
      ["stop_gained", 2],
    ]);
  });
});
