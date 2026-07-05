import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(repoRoot, "examples", "clinical-genomics");
const templatePath = join(exampleDir, "manifest.template.json");
const manifestPath = join(exampleDir, "manifest.json");
const check = process.argv.includes("--check");

const template = JSON.parse(await fs.readFile(templatePath, "utf8"));

for (const op of template.provides?.operations ?? []) {
  const sql = op.sql ?? {};
  if (!sql.sqlFile) continue;
  const sqlText = await fs.readFile(join(exampleDir, sql.sqlFile), "utf8");
  sql.sqlTemplate = sqlText.trim();
  delete sql.sqlFile;
}

const rendered = `${JSON.stringify(template, null, 2)}\n`;

if (check) {
  let current = "";
  try {
    current = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`missing generated manifest: ${manifestPath}`);
  }
  if (current !== rendered) {
    throw new Error("examples/clinical-genomics/manifest.json is stale; run npm run manifest:clinical");
  }
} else {
  await fs.writeFile(manifestPath, rendered);
}
