import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBioOperationFromManifest, runsRoot } from "../src/hosts/run-store.js";

// Dogfood + anti-rot gate for the user guide: extract the EXACT manifest + CSV from docs/guide.md and run
// them end to end. If someone edits the guide's example into something that does not validate or run, this
// fails — the published walkthrough cannot rot, the same contract as the docs-index / README gates.

async function guideBlocks(): Promise<Array<{ lang: string; body: string }>> {
  const guide = await fs.readFile("docs/guide.md", "utf8");
  return [...guide.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => ({ lang: m[1]!, body: m[2]! }));
}

describe("user guide example runs end to end (anti-rot gate)", () => {
  test("the guide's manifest + CSV produce the counts it claims", async () => {
    const blocks = await guideBlocks();
    const manifestBlock = blocks.find((b) => b.lang === "json" && b.body.includes('"pi-bio.domain_pack_manifest.v1"'));
    const csvBlock = blocks.find((b) => b.lang === "csv");
    assert.ok(manifestBlock, "guide must contain a domain-pack manifest JSON block");
    assert.ok(csvBlock, "guide must contain the example CSV block");
    const manifest = JSON.parse(manifestBlock.body); // must be valid JSON

    const cwd = await fs.mkdtemp(join(tmpdir(), "guide-"));
    await fs.mkdir(join(cwd, "data"), { recursive: true });
    await fs.writeFile(join(cwd, "data", "variants.csv"), csvBlock.body, "utf8");
    await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(manifest), "utf8");

    const res = await runBioOperationFromManifest({
      cwd, dbPath: ":memory:", manifestPath: "manifest.json", operationId: "counts.by_consequence", runId: "guide-1", now: "2026-06-29T00:00:00Z",
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");

    const result = JSON.parse(await fs.readFile(join(runsRoot(cwd), "guide-1", "result.json"), "utf8"));
    // the guide's CSV: stop_gained x2, missense x1 — exactly what the operation's GROUP BY returns
    assert.deepEqual(result.rows.map((r: { consequence: string; n: number }) => [r.consequence, Number(r.n)]), [
      ["missense", 1],
      ["stop_gained", 2],
    ]);
  });
});
