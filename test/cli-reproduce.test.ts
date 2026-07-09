import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mainReproduce } from "../src/cli/reproduce.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";

test("CLI reproduce exposes the existing digest-verification contract", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-cli-reproduce-"));
  const original = await runBioQueryFromManifest({
    cwd,
    dbPath: ":memory:",
    manifestPath: resolve("examples/variant-counts/manifest.json"),
    sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    runId: "cli-reproduce-original",
    now: "2026-07-09T00:00:00Z",
  });
  assert.equal(original.ok, true);
  const replayPath = join(original.runDir, "replay.json");
  const out: string[] = [];
  const err: string[] = [];
  const code = await mainReproduce([replayPath], { cwd, out: (line) => out.push(line), err: (line) => err.push(line) });
  assert.equal(code, 0, err.join("\n"));
  const verdict = JSON.parse(out[0]!) as { reproduced: boolean; matched: boolean; reproductionRunId: string; missing: string[]; extra: string[] };
  assert.equal(verdict.reproduced, true);
  assert.equal(verdict.matched, true);
  assert.match(verdict.reproductionRunId, /^reproduce-cli-reproduce-original-/);
  assert.deepEqual(verdict.missing, []);
  assert.deepEqual(verdict.extra, []);
});
