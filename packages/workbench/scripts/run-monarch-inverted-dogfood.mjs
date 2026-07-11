import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fsCasStore, openBioStore, runBioOperationFromManifest } from "pi-bio-agent";
import { PINNED_MONARCH_DUCKDB } from "../dist/monarch-host.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = join(repoRoot, ".pi", "bio-agent");
const monarchUrl = PINNED_MONARCH_DUCKDB;
const phenotypeIds = [
  "HP:0006813",
  "HP:0002123",
  "HP:0002133",
  "HP:0001263",
];

await fs.mkdir(stateDir, { recursive: true });
const store = await openBioStore(repoRoot);
const cas = fsCasStore(join(stateDir, "cas"));
try {
  const runId = `monarch-hypotheses-${Date.now()}`;
  const response = await runBioOperationFromManifest({
    cwd: repoRoot,
    dbPath: join(stateDir, "monarch-dogfood.duckdb"),
    manifestPath: "examples/clinical-genomics/monarch.manifest.json",
    operationId: "clinical.monarch_phenotype_hypotheses",
    runId,
    bindings: { phenotype_ids: phenotypeIds, limit: 20 },
    duckdbInitSql: [
      "LOAD httpfs",
      `ATTACH '${monarchUrl}' AS monarch (READ_ONLY)`,
    ],
    store: store.conn,
    author: "pi-bio-workbench:monarch-dogfood",
    cas,
    casMetadata: { conn: store.conn },
    serialize: false,
  });
  if (!response.ok) throw new Error(response.error);
  const resultAddress = response.casRefs?.result;
  if (!resultAddress) throw new Error("Monarch operation completed without a CAS result");
  const [algorithm, digest] = resultAddress.split(":");
  if (algorithm !== "sha256" || !digest) throw new Error(`Unsupported CAS address: ${resultAddress}`);
  const rows = JSON.parse(await fs.readFile(cas.pathFor({ algorithm, digest }), "utf8"));
  process.stdout.write(`${JSON.stringify({
    source: monarchUrl,
    phenotypeIds,
    runId: response.runId,
    rowCount: response.rowCount,
    casRefs: response.casRefs,
    rows,
  }, null, 2)}\n`);
} finally {
  store.close();
}
