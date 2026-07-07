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
  assert.match(await fs.readFile(join(dest, "pi-bio-agent", "references", "manifests.md"), "utf8"), /Manifest Syntax/);
  assert.match(await fs.readFile(join(dest, "pi-bio-agent", "references", "ledger-graph.md"), "utf8"), /Ledger And Graph Inspection/);

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
  assert.match(skillText, /Manifest Versus Ad-Hoc Query/);
  assert.match(await fs.readFile(join(dest, "pi-bio-agent", "references", "query-run.md"), "utf8"), /Ad-Hoc Query/);
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

test("Pi presets install into Pi global and project skill roots", async () => {
  const piRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-pi-global-skill-"));
  const globalOut: string[] = [];
  const globalErr: string[] = [];
  const globalCode = await mainInstallSkill(["--host", "pi"], {
    out: (line) => globalOut.push(line),
    err: (line) => globalErr.push(line),
    sourceDir: resolve("skills", "pi-bio-agent"),
    env: { PI_CODING_AGENT_DIR: piRoot },
  });
  assert.equal(globalCode, 0, globalErr.join("\n"));
  const globalInstall = JSON.parse(globalOut[0]) as { ok: boolean; host: string; installed: string; next: string };
  assert.equal(globalInstall.ok, true);
  assert.equal(globalInstall.host, "pi");
  assert.equal(globalInstall.installed, join(piRoot, "skills", "pi-bio-agent"));
  assert.match(globalInstall.next, /\/reload in Pi/);

  const cwd = process.cwd();
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-pi-project-skill-"));
  const projectOut: string[] = [];
  const projectErr: string[] = [];
  try {
    process.chdir(projectRoot);
    const projectCode = await mainInstallSkill(["--host", "pi-project"], {
      out: (line) => projectOut.push(line),
      err: (line) => projectErr.push(line),
      sourceDir: join(cwd, "skills", "pi-bio-agent"),
      env: {},
    });
    assert.equal(projectCode, 0, projectErr.join("\n"));
  } finally {
    process.chdir(cwd);
  }
  const projectInstall = JSON.parse(projectOut[0]) as { ok: boolean; host: string; installed: string };
  assert.equal(projectInstall.ok, true);
  assert.equal(projectInstall.host, "pi-project");
  assert.equal(projectInstall.installed, join(projectRoot, ".pi", "skills", "pi-bio-agent"));
  assert.match(await fs.readFile(join(projectRoot, ".pi", "skills", "pi-bio-agent", "SKILL.md"), "utf8"), /pi-bio-agent query\/run/);
});

test("Claude, OpenCode, and GitHub Copilot project presets use documented skill roots", async () => {
  const cwd = process.cwd();
  const projectRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-agent-skill-hosts-"));
  const cases = [
    ["claude-project", ".claude", "skills"],
    ["opencode-project", ".opencode", "skills"],
    ["copilot-project", ".github", "skills"],
    ["github-copilot-project", ".github", "skills"],
  ] as const;
  try {
    process.chdir(projectRoot);
    for (const [host, dir, child] of cases) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await mainInstallSkill(["--host", host, "--force"], {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        sourceDir: join(cwd, "skills", "pi-bio-agent"),
        env: {},
      });
      assert.equal(code, 0, err.join("\n"));
      const installed = JSON.parse(out[0]) as { ok: boolean; host: string; installed: string };
      assert.equal(installed.ok, true);
      assert.equal(installed.host, host);
      assert.equal(installed.installed, join(projectRoot, dir, child, "pi-bio-agent"));
      assert.match(await fs.readFile(join(projectRoot, dir, child, "pi-bio-agent", "SKILL.md"), "utf8"), /host-neutral substrate/);
    }
  } finally {
    process.chdir(cwd);
  }
});
