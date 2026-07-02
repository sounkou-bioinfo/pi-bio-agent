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
    const hist = JSON.parse(out.lines.at(-1)!).revisions as Array<{ author: string; content: { title: string; body: string } | null }>;
    assert.deepEqual(hist.map((r) => r.author), ["agent:A", "agent:B"]);
    // history shows the FULL content per revision, so WHAT changed (body/title) is visible, not just the author/time
    assert.deepEqual(hist.map((r) => r.content?.body), ["PVS1", "PVS1 refined"]);
    assert.equal(hist[1]!.content?.title, "ACMG v2");

    // history HONORS --as-of: at a time between the two revisions, only the first (agent:A @ T1) is visible
    assert.equal(await mainMemory(["history", "acmg", "--as-of", "2026-01-01T00:00:02Z"], deps), 0);
    assert.deepEqual(JSON.parse(out.lines.at(-1)!).revisions.map((r: { author: string }) => r.author), ["agent:A"], "future revisions are excluded as of an earlier time");
    // a malformed --as-of on history is a usage error (exit 2), not a silent empty result
    assert.equal(await mainMemory(["history", "acmg", "--as-of", "not-a-time"], deps), 2);

    assert.equal(await mainMemory(["bogus"], deps), 2); // usage error
    assert.equal(await mainMemory(["show", "nope"], deps), 1); // not found
    // an unknown FLAG is a clean usage error (exit 2), not an uncaught ERR_PARSE_ARGS -> generic exit 1
    assert.equal(await mainMemory(["list", "--bad"], deps), 2);
    // SURPLUS positionals are a usage error (exit 2), not a silent success against the wrong intended input
    assert.equal(await mainMemory(["list", "junk"], deps), 2);
    assert.equal(await mainMemory(["show", "acmg", "typo"], deps), 2);
    assert.equal(await mainMemory(["history", "a", "b"], deps), 2);
    // a malformed --as-of is a usage error for any command (validated before the store is opened)
    assert.equal(await mainMemory(["list", "--as-of", "not-a-time"], deps), 2);
    // STRICT ISO: a lenient form Date.parse would accept (but DuckDB may parse differently) is rejected up front
    assert.equal(await mainMemory(["list", "--as-of", "March 1 2026"], deps), 2, "non-ISO date is rejected");
    assert.equal(await mainMemory(["list", "--as-of", "2026/01/01"], deps), 2, "slash-form date is rejected");
    assert.equal(await mainMemory(["show", "acmg", "--as-of", "2026-01-01T00:00:02Z"], deps), 0, "a strict ISO instant is accepted");
  });

  test("a usage error (missing slug) is exit 2 and does NOT create/lock the store file (validated before open)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "mem-cli-usage-"));
    const deps = { cwd, out: sink().write, err: sink().write };
    assert.equal(await mainMemory(["show"], deps), 2, "show with no slug is a usage error");
    await assert.rejects(() => fs.stat(join(cwd, ".pi", "bio-agent", "store.duckdb")), "no store file was created by the pure usage error");
  });
});
