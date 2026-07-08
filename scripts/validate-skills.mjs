#!/usr/bin/env node
import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return "usage: node scripts/validate-skills.mjs [--root <skills-dir>]";
}

function parseArgs(argv) {
  const opts = { root: join(repoRoot, "skills") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a path");
      opts.root = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`unknown argument '${arg}'`);
  }
  return opts;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSkillDirs(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (await exists(join(dir, "SKILL.md"))) dirs.push(dir);
  }
  return dirs.sort();
}

async function listMarkdownFiles(dir) {
  const out = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(child);
      }
    }
  }
  await visit(dir);
  return out.sort();
}

function lineErrors(text, file, checks) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const check of checks) {
      if (check.re.test(line)) errors.push(`${file}:${index + 1}: ${check.message}`);
    }
  }
  return errors;
}

function executableFenceErrors(text, file) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const executable = new Set(["python", "py", "javascript", "js", "typescript", "ts", "r", "ruby", "go", "java", "php"]);
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^```\s*([A-Za-z0-9_-]+)/);
    if (!match) continue;
    const lang = match[1].toLowerCase();
    if (executable.has(lang)) {
      errors.push(`${file}:${index + 1}: executable ${lang} code block belongs in repo code/tests, not in the skill`);
    }
  }
  return errors;
}

function parseFrontmatter(text, file) {
  if (!text.startsWith("---\n")) return { attrs: {}, errors: [`${file}:1: missing YAML frontmatter`] };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { attrs: {}, errors: [`${file}:1: unterminated YAML frontmatter`] };
  const attrs = {};
  const errors = [];
  for (const [index, line] of text.slice(4, end).split(/\r?\n/).entries()) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      if (line.trim()) errors.push(`${file}:${index + 2}: unsupported frontmatter line`);
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    attrs[match[1]] = value;
  }
  return { attrs, errors };
}

function isExternalLink(link) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(link) || link.startsWith("#");
}

function localLinkTarget(link, sourceFile) {
  const clean = link.replace(/^<|>$/g, "").split("#")[0];
  if (!clean || isExternalLink(clean)) return undefined;
  return resolve(dirname(sourceFile), clean);
}

async function validateMarkdownLinks(text, sourceFile, skillDir) {
  const errors = [];
  const relFile = relative(repoRoot, sourceFile);
  const links = [...text.matchAll(/\]\(([^)\s]+(?:\s+\"[^\"]+\")?)\)/g)].map((m) => m[1].split(/\s+\"/)[0]);
  for (const link of links) {
    const target = localLinkTarget(link, sourceFile);
    if (!target) continue;
    const rel = relative(skillDir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      errors.push(`${relFile}: local link escapes skill directory: ${link}`);
      continue;
    }
    if (!target.endsWith(".md")) continue;
    if (!(await exists(target))) {
      errors.push(`${relFile}: missing referenced file ${link}`);
    }
  }
  return errors;
}

async function validateSkill(skillDir, root) {
  const errors = [];
  const relDir = relative(root, skillDir) || basename(skillDir);
  const skillFile = join(skillDir, "SKILL.md");
  const relSkillFile = relative(repoRoot, skillFile);
  const text = await readFile(skillFile, "utf8");
  const { attrs, errors: frontmatterErrors } = parseFrontmatter(text, relSkillFile);
  errors.push(...frontmatterErrors);
  if (attrs.name !== basename(skillDir)) errors.push(`${relSkillFile}: frontmatter name must match directory name '${basename(skillDir)}'`);
  if (typeof attrs.description !== "string" || attrs.description.length < 80) errors.push(`${relSkillFile}: description must be clear and at least 80 characters`);

  if (attrs.name === "pi-bio-agent") {
    const required = [
      "host-neutral substrate",
      "write manifests",
      "inspect DuckDB tables",
      "receipts",
      "avoid per-question skill sprawl",
    ];
    for (const phrase of required) {
      if (!attrs.description?.includes(phrase)) errors.push(`${relSkillFile}: description must include '${phrase}'`);
    }
    for (const heading of [
      "## What This Is",
      "## Manifest Versus Ad-Hoc Query",
      "## Choose The Surface",
      "## Minimal Working Loop",
      "## Load References As Needed",
      "## Answer Contract",
      "## Skill Graduation Rule",
    ]) {
      if (!text.includes(heading)) errors.push(`${relSkillFile}: missing required section '${heading}'`);
    }
  }

  const mdFiles = await listMarkdownFiles(skillDir);
  for (const path of mdFiles) {
    const rel = relative(repoRoot, path);
    const body = await readFile(path, "utf8");
    errors.push(...await validateMarkdownLinks(body, path, skillDir));
    errors.push(...executableFenceErrors(body, rel));
    errors.push(...lineErrors(body, rel, [
      { re: /\bsk-[A-Za-z0-9_-]{20,}\b/, message: "looks like an API key or model provider secret" },
      { re: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/i, message: "looks like an inline secret" },
      { re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/i, message: "authorization bearer values must not be in skills" },
      { re: /\b(MRN|SSN)\s*[:=]/i, message: "patient identifiers must not be in skills" },
      { re: /\bDOB\s*[:=]\s*\d{4}-\d{2}-\d{2}/i, message: "patient dates of birth must not be in skills" },
      { re: /\bpatient\s+name\s*[:=]/i, message: "patient-specific facts must not be in skills" },
      { re: /\b(import\s+requests|urllib\.request|requests\.(get|post)|axios\.|fetch\s*\()/i, message: "API client implementation belongs in code/tests, not in skills" },
      { re: /\bcurl\s+(-X|--request)\b/i, message: "API transport scripts belong in manifests/resolvers/code, not in skills" },
    ]));
  }

  return { skill: relDir, errors };
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const rootStats = await stat(opts.root);
  if (!rootStats.isDirectory()) throw new Error(`${opts.root} is not a directory`);
  const skillDirs = await findSkillDirs(opts.root);
  if (skillDirs.length === 0) throw new Error(`${opts.root} contains no skill directories`);
  const results = [];
  for (const dir of skillDirs) results.push(await validateSkill(dir, opts.root));
  const errors = results.flatMap((r) => r.errors);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`validate-skills: ok (${results.length} skill${results.length === 1 ? "" : "s"})`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage());
  process.exitCode = 1;
}
