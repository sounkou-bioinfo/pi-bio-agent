import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainMemory } from "../src/cli/memory.js";
import { openBioStore } from "../src/hosts/bio-store.js";
import { remember } from "../src/hosts/memory-store.js";

const sink = () => {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
};

describe("memory CLI over the ONE temporal store (replaces the stale notes CLI)", () => {
  test("list / show / history read the store; as-of time-travels; bad command is a usage error", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "mem-cli-"));
    const s1 = await openBioStore(cwd);
    await remember(s1.conn, { slug: "acmg", kind: "memory_note", title: "ACMG v1", hook: "when classifying", body: "PVS1", tags: [] }, "2026-01-01T00:00:01Z", "agent:A");
    await remember(s1.conn, { slug: "acmg", kind: "memory_note", title: "ACMG v2", hook: "when classifying", body: "PVS1 refined", tags: [] }, "2026-01-01T00:00:05Z", "agent:B");
    s1.close();

    const out = sink();
    const err = sink();
    const deps = { cwd, out: out.write, err: err.write };

    assert.equal(await mainMemory(["list"], deps), 0);
    assert.equal(JSON.parse(out.lines.at(-1)!).notes[0].slug, "acmg");

    assert.equal(await mainMemory(["show", "acmg"], deps), 0);
    assert.equal(JSON.parse(out.lines.at(-1)!).title, "ACMG v2"); // now = latest
    assert.equal(await mainMemory(["show", "acmg", "--as-of", "2026-01-01T00:00:02Z"], deps), 0);
    assert.equal(JSON.parse(out.lines.at(-1)!).title, "ACMG v1"); // as-of the first revision

    assert.equal(await mainMemory(["history", "acmg"], deps), 0);
    assert.deepEqual(JSON.parse(out.lines.at(-1)!).revisions.map((r: { author: string }) => r.author), ["agent:A", "agent:B"]);

    assert.equal(await mainMemory(["bogus"], deps), 2); // usage error
    assert.equal(await mainMemory(["show", "nope"], deps), 1); // not found
  });
});
