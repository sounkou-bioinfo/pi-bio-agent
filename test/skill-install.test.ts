import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "install-codex-skill.mjs");

test("Codex skill installer copies the package skill and refuses accidental overwrite", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-codex-skill-"));
  const dest = join(root, "skills");

  const first = await execFileAsync(process.execPath, [script, "--dest", dest], { cwd: process.cwd() });
  const installed = JSON.parse(first.stdout) as { ok: boolean; installed: string; mode: string };
  assert.equal(installed.ok, true);
  assert.equal(installed.mode, "copy");
  const skillText = await fs.readFile(join(dest, "pi-bio-agent", "SKILL.md"), "utf8");
  assert.match(skillText, /name:\s*pi-bio-agent/);
  assert.match(skillText, /pi-bio-agent query\/run/);

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--dest", dest], { cwd: process.cwd() }),
    /already exists/,
  );

  const forced = await execFileAsync(process.execPath, [script, "--dest", dest, "--force"], { cwd: process.cwd() });
  assert.equal(JSON.parse(forced.stdout).ok, true);
});
