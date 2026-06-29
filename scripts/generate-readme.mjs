#!/usr/bin/env node
// Generates the Pi tools list in README.md from the extension's registerTool() calls — the source of truth —
// so the list can never go stale by hand (it already did once: bio_run_operation was missing). Hand-editing
// the GENERATED region is banned; `--check` fails if it drifts, the same contract as the docs index.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

// Extract { name, label } from each registerTool({ ... }) call. name/label sit at the top of the call, so a
// bounded head slice is enough; order within the head does not matter (each is matched independently).
const ext = readFileSync(join(root, "extensions/pi-coding-agent/index.ts"), "utf8");
const tools = [];
for (const block of ext.split("registerTool(").slice(1)) {
  const head = block.slice(0, 600);
  const name = /name:\s*"([^"]+)"/.exec(head)?.[1];
  const label = /label:\s*"([^"]+)"/.exec(head)?.[1];
  if (name) tools.push({ name, label: label ?? "" });
}
if (tools.length === 0) {
  console.error("generate-readme: no registerTool() calls found in the extension");
  process.exit(1);
}
tools.sort((a, b) => a.name.localeCompare(b.name));

const body = tools.map((t) => `- \`${t.name}\`${t.label ? ` — ${t.label}` : ""}`).join("\n");
const generated = `<!-- BEGIN GENERATED:tools (scripts/generate-readme.mjs — do not edit by hand) -->\n${body}\n<!-- END GENERATED:tools -->`;

const readmePath = join(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
const re = /<!-- BEGIN GENERATED:tools[\s\S]*?<!-- END GENERATED:tools -->/;
if (!re.test(readme)) {
  console.error("generate-readme: README.md is missing the GENERATED:tools markers");
  process.exit(1);
}
const next = readme.replace(re, generated);

if (check) {
  if (next !== readme) {
    console.error("README tools list is stale; run `npm run readme`.");
    process.exit(1);
  }
  console.log("README is current");
} else {
  writeFileSync(readmePath, next);
  console.log(`wrote README.md tools list (${tools.length} tools)`);
}
