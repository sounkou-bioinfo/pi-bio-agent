#!/usr/bin/env node
// Generate the "## Pi tools" list in README.md + README.qmd from the extension's registerTool({ name, label })
// calls, so it can never drift. `--check` fails (exit 1) if either file's block is stale — wired into `npm run check`.
import { promises as fs } from "node:fs";

const SRC = "extensions/pi-coding-agent/index.ts";
const FILES = ["README.md", "README.qmd"];
const BEGIN = "<!-- BEGIN GENERATED:tools (scripts/generate-readme-tools.mjs — do not edit by hand) -->";
const END = "<!-- END GENERATED:tools -->";
const check = process.argv.includes("--check");

const src = await fs.readFile(SRC, "utf8");
// each tool is registered as `registerTool({ name: "…", label: "…", …})` — name is immediately followed by label.
const tools = [...src.matchAll(/registerTool\(\{\s*name:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ name: m[1], label: m[2] }));
if (tools.length === 0) {
  console.error("generate-readme-tools: found no registerTool({ name, label }) in " + SRC);
  process.exit(1);
}
const block = `${BEGIN}\n\n${tools.map((t) => `- \`${t.name}\` — ${t.label}`).join("\n")}\n\n${END}`;
const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END}`);

let stale = false;
for (const f of FILES) {
  const cur = await fs.readFile(f, "utf8");
  if (!re.test(cur)) {
    console.error(`generate-readme-tools: ${f} has no GENERATED:tools block`);
    process.exit(1);
  }
  const next = cur.replace(re, block);
  if (check) {
    if (cur !== next) {
      console.error(`generate-readme-tools: ${f} tool list is STALE — run \`npm run readme:tools\``);
      stale = true;
    }
  } else if (cur !== next) {
    await fs.writeFile(f, next, "utf8");
    console.log(`generate-readme-tools: ${f} updated (${tools.length} tools)`);
  }
}
if (check && stale) process.exit(1);
console.log(check ? `generate-readme-tools: current (${tools.length} tools)` : `generate-readme-tools: done (${tools.length} tools)`);
