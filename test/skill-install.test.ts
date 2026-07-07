import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mainInstallCodexSkill, mainInstallSkill } from "../src/cli/install-skill.js";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "install-skill.mjs");

test("generic skill installer copies the package skill and refuses accidental overwrite", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-host-skill-"));
  const dest = join(root, "skills");

  const first = await execFileAsync(process.execPath, [script, "--dest", dest], { cwd: process.cwd() });
  const installed = JSON.parse(first.stdout) as { ok: boolean; host: string; installed: string; mode: string; cli: { install: string } };
  assert.equal(installed.ok, true);
  assert.equal(installed.host, "generic");
  assert.equal(installed.mode, "copy");
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

test("package CLI command installs the generic skill from the packaged skill directory", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-host-cli-skill-"));
  const dest = join(root, "skills");
  const out: string[] = [];
  const err: string[] = [];
  const code = await mainInstallSkill(["--dest", dest], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sourceDir: resolve("skills", "pi-bio-agent"),
    env: {},
  });
  assert.equal(code, 0, err.join("\n"));
  const installed = JSON.parse(out[0]) as { ok: boolean; host: string; cli: { install: string } };
  assert.equal(installed.ok, true);
  assert.equal(installed.host, "generic");
  assert.match(installed.cli.install, /npm install -g github:sounkou-bioinfo\/pi-bio-agent/);
  const skillText = await fs.readFile(join(dest, "pi-bio-agent", "SKILL.md"), "utf8");
  assert.match(skillText, /ClawBio-like systems/);
});

test("Codex preset installs into CODEX_HOME/skills and remains available as an alias", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-codex-cli-skill-"));
  const out: string[] = [];
  const err: string[] = [];
  const code = await mainInstallCodexSkill([], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sourceDir: resolve("skills", "pi-bio-agent"),
    env: { CODEX_HOME: root },
  });
  assert.equal(code, 0, err.join("\n"));
  const installed = JSON.parse(out[0]) as { ok: boolean; host: string; installed: string; next: string };
  assert.equal(installed.ok, true);
  assert.equal(installed.host, "codex");
  assert.equal(installed.installed, join(root, "skills", "pi-bio-agent"));
  assert.match(installed.next, /Restart Codex/);
  assert.match(await fs.readFile(join(root, "skills", "pi-bio-agent", "SKILL.md"), "utf8"), /host-neutral substrate/);
});
