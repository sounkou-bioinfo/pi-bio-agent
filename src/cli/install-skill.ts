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
const HOSTS = [
  "generic",
  "pi",
  "pi-project",
  "claude",
  "claude-project",
  "opencode",
  "opencode-project",
  "copilot",
  "copilot-project",
  "github-copilot",
  "github-copilot-project",
  "codex",
] as const;
const HOST_SET = new Set<string>(HOSTS);
type HostPreset = typeof HOSTS[number];

export const installSkillUsage = (command: "install-skill" | "install-codex-skill"): string => [
  `usage: pi-bio-agent ${command} [--host <preset>|--dest <host-skills-dir>] [--force] [--link]`,
  "",
  "Installs the packaged pi-bio-agent substrate skill into an agent host's skill/playbook root.",
  `Presets: ${HOSTS.join(", ")}.`,
  "--dest is required for generic hosts.",
].join("\n");

function codexDestRoot(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "skills") : join(homedir(), ".codex", "skills");
}

function piDestRoot(env: NodeJS.ProcessEnv): string {
  const piAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  return piAgentDir ? join(piAgentDir, "skills") : join(homedir(), ".pi", "agent", "skills");
}

function presetDestRoot(host: string, env: NodeJS.ProcessEnv): string | undefined {
  if (host === "codex") return codexDestRoot(env);
  if (host === "pi") return piDestRoot(env);
  if (host === "pi-project") return resolve(".pi", "skills");
  if (host === "claude") return join(homedir(), ".claude", "skills");
  if (host === "claude-project") return resolve(".claude", "skills");
  if (host === "opencode") return join(homedir(), ".config", "opencode", "skills");
  if (host === "opencode-project") return resolve(".opencode", "skills");
  if (host === "copilot" || host === "github-copilot") return join(homedir(), ".copilot", "skills");
  if (host === "copilot-project" || host === "github-copilot-project") return resolve(".github", "skills");
  return undefined;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv, defaultHost: HostPreset, command: "install-skill" | "install-codex-skill"): { dest: string; force: boolean; link: boolean; host: string } {
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
      if (!HOST_SET.has(value)) throw new Error(`--host must be one of: ${HOSTS.join(", ")}`);
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
      throw new Error(installSkillUsage(command));
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  out.dest ??= presetDestRoot(out.host, env);
  if (!out.dest) throw new Error("--dest is required unless a host preset is selected");
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

async function installSkill(argv: string[], deps: InstallSkillDeps, defaultHost: HostPreset, command: "install-skill" | "install-codex-skill"): Promise<number> {
  const env = deps.env ?? process.env;
  let opts: { dest: string; force: boolean; link: boolean; host: string };
  try {
    opts = parseArgs(argv, env, defaultHost, command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const help = installSkillUsage(command);
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
        : opts.host === "pi" || opts.host === "pi-project"
          ? "Run /reload in Pi, or restart Pi, to pick up the pi-bio-agent skill."
          : opts.host === "claude" || opts.host === "claude-project"
            ? "Claude Code watches existing skill directories; restart Claude Code if this created the top-level skills directory."
            : opts.host === "opencode" || opts.host === "opencode-project"
              ? "Restart or reload OpenCode if it does not pick up the new skill immediately."
              : opts.host === "copilot" || opts.host === "copilot-project" || opts.host === "github-copilot" || opts.host === "github-copilot-project"
                ? "Restart GitHub Copilot CLI or the Copilot host if it caches skills."
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
