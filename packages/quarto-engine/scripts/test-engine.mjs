import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "output.md");
const failureDocument = join(root, ".quarto-engine-failure.qmd");
const failureOutput = join(root, ".quarto-engine-failure.md");

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
