import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(root, "../..");
const generatedEngine = join(workspaceRoot, "_extensions/pi-bio/pi-bio.js");
const output = join(root, "output.md");
const failureDocument = join(root, ".quarto-engine-failure.qmd");
const failureOutput = join(root, ".quarto-engine-failure.md");
const visibilityDocument = join(root, ".quarto-engine-visibility.qmd");
const visibilityOutput = join(root, ".quarto-engine-visibility.md");

if (process.argv.includes("--check-generated")) {
  const before = await fs.readFile(generatedEngine, "utf8");
  await execFileAsync("quarto", ["call", "build-ts-extension", "packages/quarto-engine/src/pi-bio.ts"], {
    cwd: workspaceRoot,
    maxBuffer: 1024 * 1024,
  });
  const after = await fs.readFile(generatedEngine, "utf8");
  if (after !== before) {
    await fs.writeFile(generatedEngine, before, "utf8");
    throw new Error("generated pi-bio engine is stale; run npm run build --workspace=packages/quarto-engine");
  }
  console.log("pi-bio-quarto: generated engine is current");
  process.exit(0);
}

if (process.argv.includes("--check-readme")) {
  const readme = join(root, "README.md");
  const before = await fs.readFile(readme, "utf8");
  await execFileAsync("quarto", ["render", "README.qmd", "--to", "gfm", "--output", "README.md"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const after = await fs.readFile(readme, "utf8");
  if (after !== before) {
    await fs.writeFile(readme, before, "utf8");
    throw new Error("generated Quarto README is stale; run npm run readme:qmd --workspace=packages/quarto-engine");
  }
  console.log("pi-bio-quarto: generated README is current");
  process.exit(0);
}

await execFileAsync("quarto", ["render", "examples/basic.qmd", "--to", "markdown", "--output", "output.md"], {
  cwd: root,
  maxBuffer: 1024 * 1024,
});

const rendered = await fs.readFile(output, "utf8");
await fs.rm(output, { force: true });
await fs.rm(join(root, ".quarto-engine-figure.svg"), { force: true });

for (const needle of [
  "Trusted Node/TypeScript cells",
  "mean",
  "total=10",
  "doubled",
  "9007199254740993n",
  "A derived figure",
  "![A derived figure](../.quarto-engine-figure.svg)",
  "A file-backed view emitted through Quarto supporting files.",
  "R is an explicit host runtime",
  "shell is an explicit host runtime",
  "stop_gained",
  "missense",
  "user-output-preserved",
  "<details class=\"pi-bio-output\">",
]) {
  if (!rendered.includes(needle)) throw new Error(`Quarto engine output is missing '${needle}'`);
}

if (rendered.includes("Error:") || rendered.includes("Hello from pi-bio")) {
  throw new Error("Quarto engine output contains an unexpected failure/example marker");
}

await fs.writeFile(visibilityDocument, `---
title: "Quarto engine visibility"
engine: pi-bio
---

\`\`\`{ts .pi-bio}
#| include: false
const hiddenValue = "state-survives-hidden-cell";
console.log("HIDDEN_OUTPUT");
\`\`\`

\`\`\`{ts .pi-bio}
#| echo: false
piBio.markdown(hiddenValue);
\`\`\`

\`\`\`{ts .pi-bio}
#| output: false
console.log("SUPPRESSED_OUTPUT");
\`\`\`
`, "utf8");
try {
  await execFileAsync("quarto", ["render", ".quarto-engine-visibility.qmd", "--to", "markdown", "--output", ".quarto-engine-visibility.md"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const visibility = await fs.readFile(visibilityOutput, "utf8");
  if (!visibility.includes("state-survives-hidden-cell")) throw new Error("hidden cell state was not available downstream");
  for (const forbidden of ["HIDDEN_OUTPUT", "piBio.markdown(hiddenValue)"]) {
    if (visibility.includes(forbidden)) throw new Error(`Quarto visibility option leaked '${forbidden}'`);
  }
  if (!visibility.includes('console.log("SUPPRESSED_OUTPUT")')) throw new Error("output=false unexpectedly hid source");
  if (visibility.split("SUPPRESSED_OUTPUT").length !== 2) throw new Error("output=false leaked runtime output");
} finally {
  await fs.rm(visibilityDocument, { force: true });
  await fs.rm(visibilityOutput, { force: true });
}

let previous = -1;
for (const needle of ["mean", "doubled", "R is an explicit host runtime", "shell is an explicit host runtime", "stop_gained"]) {
  const position = rendered.indexOf(needle);
  if (position <= previous) throw new Error(`Quarto engine output is out of order at '${needle}'`);
  previous = position;
}

await fs.writeFile(failureDocument, `---
title: "Quarto engine failure"
engine: pi-bio
---

\`\`\`{ts .pi-bio}
Promise.reject(new Error("expected async cell failure"));
\`\`\`

\`\`\`{ts .pi-bio}
process.stdout.write("LATER_CELL_RAN");
\`\`\`
`, "utf8");
try {
  await execFileAsync("quarto", ["render", ".quarto-engine-failure.qmd", "--to", "markdown", "--output", ".quarto-engine-failure.md"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  throw new Error("Quarto engine accepted a failing cell");
} catch (error) {
  const failureText = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  if (!failureText.includes("cell-1 failed") || failureText.includes("LATER_CELL_RAN")) {
    throw new Error(`Quarto engine did not fail fast with cell attribution:\n${failureText}`);
  }
} finally {
  await fs.rm(failureDocument, { force: true });
  await fs.rm(failureOutput, { force: true });
}

const processFailureDocument = join(root, ".quarto-engine-process-failure.qmd");
const processFailureOutput = join(root, ".quarto-engine-process-failure.md");
await fs.writeFile(processFailureDocument, `---
title: "Quarto engine process failure"
engine: pi-bio
---

\`\`\`{bash .pi-bio}
exit 7
\`\`\`

\`\`\`{ts .pi-bio}
process.stdout.write("LATER_PROCESS_CELL_RAN");
\`\`\`
`, "utf8");
try {
  await execFileAsync("quarto", ["render", ".quarto-engine-process-failure.qmd", "--to", "markdown", "--output", ".quarto-engine-process-failure.md"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  throw new Error("Quarto engine accepted a failing subprocess");
} catch (error) {
  const failureText = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  if (!failureText.includes("bash cell failed") || failureText.includes("LATER_PROCESS_CELL_RAN")) {
    throw new Error(`Quarto engine did not fail fast on a subprocess:\n${failureText}`);
  }
} finally {
  await fs.rm(processFailureDocument, { force: true });
  await fs.rm(processFailureOutput, { force: true });
}

console.log("pi-bio-quarto: rendered persistent TypeScript cells successfully");
