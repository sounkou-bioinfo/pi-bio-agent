import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mainInstallCodexSkill } from "../src/cli/install-codex-skill.js";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "install-codex-skill.mjs");

test("Codex skill installer copies the package skill and refuses accidental overwrite", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-codex-skill-"));
  const dest = join(root, "skills");

  const first = await execFileAsync(process.execPath, [script, "--dest", dest], { cwd: process.cwd() });
  const installed = JSON.parse(first.stdout) as { ok: boolean; installed: string; mode: string; cli: { availableOnPath: boolean; install: string } };
  assert.equal(installed.ok, true);
  assert.equal(installed.mode, "copy");
  assert.equal(typeof installed.cli.availableOnPath, "boolean");
  assert.match(installed.cli.install, /CLI|Install the CLI/);
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

test("package CLI command installs the Codex skill from the packaged skill directory", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-codex-cli-skill-"));
  const dest = join(root, "skills");
  const out: string[] = [];
  const err: string[] = [];
  const code = await mainInstallCodexSkill(["--dest", dest], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sourceDir: resolve("skills", "pi-bio-agent"),
    env: {},
  });
  assert.equal(code, 0, err.join("\n"));
  const installed = JSON.parse(out[0]) as { ok: boolean; cli: { availableOnPath: boolean; install: string } };
  assert.equal(installed.ok, true);
  assert.equal(installed.cli.availableOnPath, true);
  assert.match(installed.cli.install, /CLI is available/);
  const skillText = await fs.readFile(join(dest, "pi-bio-agent", "SKILL.md"), "utf8");
  assert.match(skillText, /ClawBio-like systems/);
});
