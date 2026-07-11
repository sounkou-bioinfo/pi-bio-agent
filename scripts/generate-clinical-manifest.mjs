import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(repoRoot, "examples", "clinical-genomics");
const check = process.argv.includes("--check");
const manifests = [
  { templateName: "manifest.template.json", manifestName: "manifest.json" },
  { templateName: "monarch.manifest.template.json", manifestName: "monarch.manifest.json" },
  { templateName: "monarch.manifest.template.json", manifestName: "monarch.fixture.manifest.json", fixture: true },
  { templateName: "gene-intervals.manifest.template.json", manifestName: "gene-intervals.manifest.json" },
  { templateName: "variant-search.manifest.template.json", manifestName: "variant-search.manifest.json" },
];

const fixtureSources = {
  case_phenotype_ancestors: ["file:data/monarch_closure.csv"],
  monarch_disease_phenotype_matches: [
    "file:data/monarch_edges.csv",
    "file:data/monarch_nodes.csv",
    "file:data/monarch_closure.csv",
  ],
  monarch_gene_disease_evidence: ["file:data/monarch_edges.csv", "file:data/monarch_nodes.csv"],
};

async function inlineSql(target, textKey) {
  if (!target?.sqlFile) return;
  const sqlText = await fs.readFile(join(exampleDir, target.sqlFile), "utf8");
  target[textKey] = sqlText.trim();
  delete target.sqlFile;
}

for (const { templateName, manifestName, fixture } of manifests) {
  const templatePath = join(exampleDir, templateName);
  const manifestPath = join(exampleDir, manifestName);
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  if (fixture) {
    template.id = "clinical-genomics-monarch-fixture";
    template.title = "Phenotype-to-gene hypotheses over the canonical graph fixture";
    template.description = "Hermetic canonical edges, nodes, and closure tables used to exercise the same inverted traversal as the pinned Monarch snapshot.";
    for (const resource of template.provides?.resources ?? []) {
      if (resource.id in fixtureSources) resource.params.declaredSources = fixtureSources[resource.id];
    }
  }
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
