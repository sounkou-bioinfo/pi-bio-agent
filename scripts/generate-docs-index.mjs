#!/usr/bin/env node
// Generates docs/index.json (machine/agent) and docs/INDEX.md (human) from the OKF frontmatter on each
// docs/*.md. Source of truth is the individual docs; these two files are generated caches, validated by
// `--check`.
//
// This is OKF-*compatible*, not full OKF: the strict, fail-closed parser accepts only our local supported
// subset — `type`, `title`, `description`, `tags` — and throws on any other key or unquoted ':' rather than
// pulling in a general YAML dependency. To support a new key (e.g. `resource`, `updated`), add it here; the
// parser rejects unknown keys by design.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const check = process.argv.includes("--check");

/** Strip a single layer of surrounding quotes, unescaping \" and \\. Plain (unquoted) scalars pass through. */
function scalar(raw, where) {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (v.includes(": ")) throw new Error(`${where}: unquoted ':' in a value — quote it ("...")`);
  return v;
}

function parseFrontmatter(file, text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`docs/${file}: missing frontmatter (every doc needs type/title/description/tags)`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`docs/${file}: unparseable frontmatter line: ${line}`);
    const [, key, rest] = kv;
    if (key === "tags") {
      const inner = rest.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
      fm.tags = inner ? inner.split(",").map((t) => scalar(t, `docs/${file} tags`)) : [];
    } else if (key === "type" || key === "title" || key === "description") {
      fm[key] = scalar(rest, `docs/${file} ${key}`);
    } else {
      throw new Error(`docs/${file}: unknown frontmatter key '${key}'`);
    }
  }
  for (const key of ["type", "title", "description"]) {
    if (!fm[key]) throw new Error(`docs/${file}: frontmatter '${key}' is required`);
  }
  return { slug: file.replace(/\.md$/, ""), path: `docs/${file}`, type: fm.type, title: fm.title, description: fm.description, tags: fm.tags ?? [] };
}

const entries = readdirSync(docsDir)
  .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
  .sort()
  .map((f) => parseFrontmatter(f, readFileSync(join(docsDir, f), "utf8")))
  .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));

const indexJson = `${JSON.stringify({ schema: "pi-bio.docs_index.v1", note: "generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs — do not edit by hand", docs: entries }, null, 2)}\n`;

const md = ["<!-- generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs; do not edit by hand -->", "# Docs index", ""];
let type = null;
for (const e of entries) {
  if (e.type !== type) {
    type = e.type;
    if (md[md.length - 1] !== "") md.push("");
    md.push(`## ${type}`, "");
  }
  const tags = e.tags.length ? ` _(${e.tags.join(", ")})_` : "";
  md.push(`- [${e.title}](${e.slug}.md) — ${e.description}${tags}`);
}
md.push("");
const indexMd = md.join("\n");

const read = (name) => { try { return readFileSync(join(docsDir, name), "utf8"); } catch { return null; } };

if (check) {
  if (read("index.json") !== indexJson || read("INDEX.md") !== indexMd) {
    console.error("docs index is stale; run `npm run docs:index`.");
    process.exit(1);
  }
  console.log("docs index is current");
} else {
  writeFileSync(join(docsDir, "index.json"), indexJson);
  writeFileSync(join(docsDir, "INDEX.md"), indexMd);
  console.log(`wrote docs/index.json and docs/INDEX.md (${entries.length} docs)`);
}
