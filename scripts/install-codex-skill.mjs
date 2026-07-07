#!/usr/bin/env node
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "skills", "pi-bio-agent");
const execFileAsync = promisify(execFile);
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function usage() {
  return [
    "usage: node scripts/install-codex-skill.mjs [--dest <codex-skills-dir>] [--force] [--link] [--link-cli]",
    "",
    "Installs skills/pi-bio-agent into Codex's skill root.",
    "--link-cli also runs `npm run build` and `npm link` so `pi-bio-agent` is on PATH.",
    "Default dest: $CODEX_HOME/skills, or ~/.codex/skills when CODEX_HOME is unset.",
  ].join("\n");
}

function defaultDestRoot() {
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "skills") : join(homedir(), ".codex", "skills");
}

function parseArgs(argv) {
  const out = { dest: defaultDestRoot(), force: false, link: false, linkCli: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--link") {
      out.link = true;
      continue;
    }
    if (arg === "--link-cli") {
      out.linkCli = true;
      continue;
    }
    if (arg === "--dest") {
      const value = argv[++i];
      if (!value) throw new Error("--dest requires a path");
      out.dest = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  return out;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateSkill(path) {
  const text = await readFile(join(path, "SKILL.md"), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${path}/SKILL.md is missing YAML frontmatter`);
  if (!/^name:\s*pi-bio-agent\s*$/m.test(text)) throw new Error(`${path}/SKILL.md does not declare name: pi-bio-agent`);
  if (!/^description:\s*.+$/m.test(text)) throw new Error(`${path}/SKILL.md is missing a description`);
}

async function commandAvailable(command) {
  try {
    await execFileAsync(command, [], { maxBuffer: 1024 * 1024 });
    return true;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return false;
    return true;
  }
}

async function linkCli() {
  await execFileAsync(npmCmd, ["run", "build"], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
  await execFileAsync(npmCmd, ["link"], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
}

try {
  const opts = parseArgs(process.argv.slice(2));
  await validateSkill(source);

  const target = join(opts.dest, "pi-bio-agent");
  if (await exists(target)) {
    if (!opts.force) {
      throw new Error(`${target} already exists; pass --force to replace it`);
    }
    await rm(target, { recursive: true, force: true });
  }

  await mkdir(opts.dest, { recursive: true });
  if (opts.link) {
    await symlink(source, target, "dir");
  } else {
    await cp(source, target, { recursive: true });
  }
  await validateSkill(target);

  const cliBeforeLink = await commandAvailable("pi-bio-agent");
  if (opts.linkCli && !cliBeforeLink) await linkCli();
  const cliAvailable = await commandAvailable("pi-bio-agent");

  console.log(JSON.stringify({
    ok: true,
    host: "codex",
    installed: target,
    source,
    mode: opts.link ? "symlink" : "copy",
    cli: {
      command: "pi-bio-agent",
      availableOnPath: cliAvailable,
      linkedByInstaller: opts.linkCli && !cliBeforeLink,
      install: cliAvailable
        ? "CLI is available on PATH."
        : "Install the CLI separately: run `npm install -g github:sounkou-bioinfo/pi-bio-agent`, or from a checkout run `npm install && npm run build && npm link`, or rerun this installer with `--link-cli`.",
    },
    next: "Restart Codex to pick up the pi-bio-agent skill.",
  }, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage());
  process.exitCode = 1;
}
