import { resolve } from "node:path";
import {
  registerPublishedAcmgWorkbookArchiveFile,
  registerPublishedAcmgWorkbookFile,
} from "../dist/index.js";

function usage() {
  return `Usage:
  npm run benchmark:acmg --workspace=packages/workbench -- \\
    (--archive <tables.zip> --expected-archive-digest sha256:... | --workbook <tables.xlsx>) \\
    --expected-workbook-digest sha256:... [--workspace <dir>] [--dataset-id <id>] [--version <id>]

The command CAS-pins the source bytes and normalized bundle, records a SQL validation run, and prints bounded
registration/quality metadata. It never treats S1-S7 development rows as held-out validation.`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(usage());
    values.set(flag.slice(2), value);
  }
  const archive = values.get("archive");
  const workbook = values.get("workbook");
  if ((archive ? 1 : 0) + (workbook ? 1 : 0) !== 1) throw new Error(usage());
  const expectedWorkbookDigest = values.get("expected-workbook-digest");
  if (!expectedWorkbookDigest) throw new Error(usage());
  if (archive && !values.get("expected-archive-digest")) throw new Error(usage());
  return {
    archive,
    workbook,
    expectedArchiveDigest: values.get("expected-archive-digest"),
    expectedWorkbookDigest,
    workspace: resolve(values.get("workspace") ?? ".pi/published-acmg-benchmark"),
    datasetId: values.get("dataset-id") ?? "ma-2025-acmg-llm",
    version: values.get("version") ?? "adz4172-tables-s1-s13",
    sourceUri: values.get("source-uri") ?? "urn:doi:10.1126/scitranslmed.adz4172#tables-s1-s13",
    citation: values.get("citation") ?? "Ma et al., Science Translational Medicine, adz4172, supplementary tables S1-S13",
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const common = {
    datasetId: args.datasetId,
    version: args.version,
    sourceUri: args.sourceUri,
    citation: args.citation,
    expectedWorkbookDigest: args.expectedWorkbookDigest,
  };
  const result = args.archive
    ? await registerPublishedAcmgWorkbookArchiveFile(args.workspace, {
        ...common,
        archivePath: resolve(args.archive),
        expectedArchiveDigest: args.expectedArchiveDigest,
      })
    : await registerPublishedAcmgWorkbookFile(args.workspace, {
        ...common,
        workbookPath: resolve(args.workbook),
      });
  process.stdout.write(`${JSON.stringify({
    registration: result.registration,
    validationRows: result.validationRows,
    quality: result.bundle.quality,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
