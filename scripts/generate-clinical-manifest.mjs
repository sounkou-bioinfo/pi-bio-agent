import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(repoRoot, "examples", "clinical-genomics");
const check = process.argv.includes("--check");
const manifests = [
  ["manifest.template.json", "manifest.json"],
  ["monarch.manifest.template.json", "monarch.manifest.json"],
];

async function inlineSql(target, textKey) {
  if (!target?.sqlFile) return;
  const sqlText = await fs.readFile(join(exampleDir, target.sqlFile), "utf8");
  target[textKey] = sqlText.trim();
  delete target.sqlFile;
}

for (const [templateName, manifestName] of manifests) {
  const templatePath = join(exampleDir, templateName);
  const manifestPath = join(exampleDir, manifestName);
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  for (const resource of template.provides?.resources ?? []) {
    await inlineSql(resource.params, "sql");
  }
  for (const operation of template.provides?.operations ?? []) {
    await inlineSql(operation.sql, "sqlTemplate");
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
      throw new Error(`${manifestPath} is stale; run npm run manifest:clinical`);
    }
  } else {
    await fs.writeFile(manifestPath, rendered);
  }
}
