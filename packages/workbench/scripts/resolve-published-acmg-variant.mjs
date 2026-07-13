import { resolve } from "node:path";
import { resolvePublishedVariantWithNcbi } from "../dist/index.js";

function usage() {
  return `Usage:
  npm run resolve:acmg-variant --workspace=packages/workbench -- \
    --row-id <published-row-id> [--workspace <dir>] [--dataset-id <id>] [--version <id>] [--refresh true]

The command resolves one registered workbook row through live NCBI Variation and ClinVar endpoints. Every response
is retained in CAS and the resolved identity is linked to the published row in the temporal ledger.`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(usage());
    values.set(flag.slice(2), value);
  }
  const rowId = values.get("row-id");
  if (!rowId) throw new Error(usage());
  return {
    rowId,
    workspace: resolve(values.get("workspace") ?? ".pi/published-acmg-benchmark"),
    datasetId: values.get("dataset-id") ?? "ma-2025-acmg-llm",
    version: values.get("version") ?? "adz4172-tables-s1-s13",
    forceRefresh: values.get("refresh") === "true",
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await resolvePublishedVariantWithNcbi(args.workspace, {
    datasetId: args.datasetId,
    version: args.version,
    rowId: args.rowId,
    fetch,
    forceRefresh: args.forceRefresh,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
