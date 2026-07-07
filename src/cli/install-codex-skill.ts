import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallCodexSkillDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  sourceDir?: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultSource = join(packageRoot, "skills", "pi-bio-agent");

const USAGE = [
  "usage: pi-bio-agent install-codex-skill [--dest <codex-skills-dir>] [--force] [--link]",
  "",
  "Installs the packaged pi-bio-agent skill into Codex's skill root.",
  "Default dest: $CODEX_HOME/skills, or ~/.codex/skills when CODEX_HOME is unset.",
].join("\n");

function defaultDestRoot(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome ? join(codexHome, "skills") : join(homedir(), ".codex", "skills");
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): { dest: string; force: boolean; link: boolean } {
  const out = { dest: defaultDestRoot(env), force: false, link: false };
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
    if (arg === "--dest") {
      const value = argv[++i];
      if (!value) throw new Error("--dest requires a path");
      out.dest = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(USAGE);
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  return out;
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

export async function mainInstallCodexSkill(argv: string[], deps: InstallCodexSkillDeps): Promise<number> {
  const env = deps.env ?? process.env;
  let opts: { dest: string; force: boolean; link: boolean };
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== USAGE) deps.err(message);
    deps.err(USAGE);
    return message === USAGE ? 0 : 2;
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
      host: "codex",
      installed: target,
      source,
      mode: opts.link ? "symlink" : "copy",
      cli: {
        command: "pi-bio-agent",
        availableOnPath: true,
        install: "CLI is available because this command is running from the pi-bio-agent package.",
      },
      next: "Restart Codex to pick up the pi-bio-agent skill.",
    }, null, 2));
    return 0;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
