import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

// Closing over RLM (Recursive Language Models): RLM stores a huge context as a variable in a Python REPL and
// recursively sub-queries an LM to answer distributional questions; on OOLONG ("among instances for these user
// IDs, how many are label X") it recurses and makes COUNTING errors at long context. Here the same context is a
// DuckDB TABLE and the answer is one GROUP BY — deterministic, and the agent only ever sees the BOUNDED result
// (no context rot). This runs that as data through the host: file_scan -> entries table -> the agent's GROUP BY.

const MANIFEST = resolve(process.cwd(), "examples", "long-context-aggregate", "manifest.json");

describe("example: RLM's long-context aggregate is a GROUP BY", () => {
  test("'among instances for user IDs 1,2,3, how many of each label' is one deterministic SQL aggregate", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-rlm-"));
    // the distributional query, RLM-OOLONG-shaped — a user-id subset filter + a count by label
    const sql = "SELECT label, count(*) AS n FROM entries WHERE user_id IN (1, 2, 3) GROUP BY label ORDER BY label";
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql, runId: "r1", now: "T1" });

    assert.equal(out.ok, true);
    if (!out.ok) return;
    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ label: string; n: number | bigint }> };
    const counts = Object.fromEntries(result.rows.map((r) => [r.label, Number(r.n)]));
    // users 1,2,3 -> entity x3, number x3, location x2, human x1 (9 rows; description is absent for this subset)
    assert.deepEqual(counts, { entity: 3, human: 1, location: 2, number: 3 });
  });

  test("'grep' narrows the same table without an LM — a regex filter is just SQL", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-rlm-"));
    // RLM's grep pattern (narrow the context) is WHERE regexp_matches — still bounded, still deterministic
    const sql = "SELECT count(*) AS n FROM entries WHERE regexp_matches(instance, 'Calypso')";
    const out = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql, runId: "r2", now: "T1" });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ n: number | bigint }> };
    assert.equal(Number(result.rows[0]!.n), 2); // two instances mention Calypso
  });
});
