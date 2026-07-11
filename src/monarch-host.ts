import { join, resolve } from "node:path";

export const PINNED_MONARCH_DUCKDB = "https://data.monarchinitiative.org/monarch-kg/2026-04-14/monarch-kg.duckdb";

export interface PhenotypeHypothesisRuntime {
  manifestPath: string;
  operationId: "clinical.monarch_phenotype_hypotheses";
  duckdbInitSql: string[];
  limit: number;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function localMonarchFixtureRuntime(workspace: string): PhenotypeHypothesisRuntime {
  const data = resolve(workspace, "data");
  return {
    manifestPath: resolve(workspace, "monarch.fixture.manifest.json"),
    operationId: "clinical.monarch_phenotype_hypotheses",
    duckdbInitSql: [
      "ATTACH ':memory:' AS monarch",
      `CREATE TABLE monarch.nodes AS SELECT * FROM read_csv(${sqlString(join(data, "monarch_nodes.csv"))}, header=true, all_varchar=true)`,
      `CREATE TABLE monarch.edges AS SELECT * FROM read_csv(${sqlString(join(data, "monarch_edges.csv"))}, header=true, all_varchar=true)`,
      `CREATE TABLE monarch.closure AS SELECT * FROM read_csv(${sqlString(join(data, "monarch_closure.csv"))}, header=true, all_varchar=true)`,
    ],
    limit: 50,
  };
}

export function pinnedMonarchRuntime(workspace: string): PhenotypeHypothesisRuntime {
  return {
    manifestPath: resolve(workspace, "monarch.manifest.json"),
    operationId: "clinical.monarch_phenotype_hypotheses",
    duckdbInitSql: [
      "LOAD httpfs",
      `ATTACH '${PINNED_MONARCH_DUCKDB}' AS monarch (READ_ONLY)`,
    ],
    limit: 50,
  };
}
