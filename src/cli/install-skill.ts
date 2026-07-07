import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallSkillDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  sourceDir?: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultSource = join(packageRoot, "skills", "pi-bio-agent");
const HOSTS = new Set(["codex", "generic"]);

const usage = (command: "install-skill" | "install-codex-skill"): string => [
  `usage: pi-bio-agent ${command} [--host codex|generic] [--dest <host-skills-dir>] [--force] [--link]`,
  "",
  "Installs the packaged pi-bio-agent substrate skill into an agent host's skill/playbook root.",
  "--dest is required for generic hosts. --host codex defaults to $CODEX_HOME/skills or ~/.codex/skills.",
].join("\n");

function codexDestRoot(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "skills") : join(homedir(), ".codex", "skills");
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv, defaultHost: "codex" | "generic", command: "install-skill" | "install-codex-skill"): { dest: string; force: boolean; link: boolean; host: string } {
  const out: { dest?: string; force: boolean; link: boolean; host: string } = { force: false, link: false, host: defaultHost };
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
    if (arg === "--host") {
      const value = argv[++i];
      if (!value) throw new Error("--host requires a value");
      if (!HOSTS.has(value)) throw new Error("--host must be one of: codex, generic");
      out.host = value;
      continue;
    }
    if (arg === "--dest") {
      const value = argv[++i];
      if (!value) throw new Error("--dest requires a path");
      out.dest = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage(command));
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  if (!out.dest && out.host === "codex") out.dest = codexDestRoot(env);
  if (!out.dest) throw new Error("--dest is required unless --host codex is selected");
  return { ...out, dest: out.dest };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function validateSkill(path: string): Promise<void> {
  const text = await readFile(join(path, "SKILL.md"), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${path}/SKILL.md is missing YAML frontmatter`);
  if (!/^name:\s*pi-bio-agent\s*$/m.test(text)) throw new Error(`${path}/SKILL.md does not declare name: pi-bio-agent`);
  if (!/^description:\s*.+$/m.test(text)) throw new Error(`${path}/SKILL.md is missing a description`);
}

async function installSkill(argv: string[], deps: InstallSkillDeps, defaultHost: "codex" | "generic", command: "install-skill" | "install-codex-skill"): Promise<number> {
  const env = deps.env ?? process.env;
  let opts: { dest: string; force: boolean; link: boolean; host: string };
  try {
    opts = parseArgs(argv, env, defaultHost, command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const help = usage(command);
    if (message !== help) deps.err(message);
    deps.err(help);
    return message === help ? 0 : 2;
  }

  const source = deps.sourceDir ?? defaultSource;
  try {
    await validateSkill(source);
    const target = join(opts.dest, "pi-bio-agent");
    if (await exists(target)) {
      if (!opts.force) throw new Error(`${target} already exists; pass --force to replace it`);
      await rm(target, { recursive: true, force: true });
    }
    await mkdir(opts.dest, { recursive: true });
    if (opts.link) {
      await symlink(source, target, "dir");
    } else {
      await cp(source, target, { recursive: true });
    }
    await validateSkill(target);
    deps.out(JSON.stringify({
      ok: true,
      host: opts.host,
      installed: target,
      source,
      mode: opts.link ? "symlink" : "copy",
      cli: {
        command: "pi-bio-agent",
        install: "Install the CLI for future runs with `npm install -g github:sounkou-bioinfo/pi-bio-agent`; this command only installs the skill directory.",
      },
      next: opts.host === "codex"
        ? "Restart Codex to pick up the pi-bio-agent skill."
        : "Restart or reload the target agent host if it caches skills.",
    }, null, 2));
    return 0;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function mainInstallSkill(argv: string[], deps: InstallSkillDeps): Promise<number> {
  return installSkill(argv, deps, "generic", "install-skill");
}

export async function mainInstallCodexSkill(argv: string[], deps: InstallSkillDeps): Promise<number> {
  return installSkill(argv, deps, "codex", "install-codex-skill");
}
