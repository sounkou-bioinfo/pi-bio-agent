import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { createBioRegistry, type DomainPackManifest } from "../src/core/manifest.js";
import type { SqlConn } from "../src/core/ports.js";
import { runOperation } from "../src/core/operations.js";
import { materializeScaleMembers } from "../src/core/scales.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { inlineTableResolver } from "./support/inline-table-resolver.js";

// An ordinal scale (ACMG) is DATA: a ranked TermSet. The substrate projects it to scale_members and the
// operation SQL thresholds on RANK (not string compare). No ACMG-specific TypeScript exists anywhere — swap
// the manifest's TermSet and the same machinery does variant impact, clinical stage, ECOG, Likert, ...

const ACMG = {
  id: "acmg_classification", title: "ACMG classification", ordered: true,
  members: [
    { id: "benign", label: "benign", rank: 0 },
    { id: "likely_benign", label: "likely benign", rank: 1 },
    { id: "vus", label: "VUS", rank: 2 },
    { id: "likely_pathogenic", label: "likely pathogenic", rank: 3 },
    { id: "pathogenic", label: "pathogenic", rank: 4 },
  ],
};

const VARIANTS = [
  { variant_key: "1:1:A:T", acmg_classification: "pathogenic" },
  { variant_key: "2:2:C:G", acmg_classification: "likely_pathogenic" },
  { variant_key: "3:3:G:A", acmg_classification: "vus" },
  { variant_key: "4:4:T:C", acmg_classification: "benign" },
];

// keep variants at or above 'likely_pathogenic' on the ACMG scale — BY RANK, joined from scale_members
const SQL = [
  "SELECT v.variant_key, s.rank",
  "FROM variant_calls v",
  "JOIN scale_members s ON s.scale_id = 'acmg_classification' AND s.member_id = v.acmg_classification",
  "JOIN scale_members cutoff ON cutoff.scale_id = 'acmg_classification' AND cutoff.member_id = 'likely_pathogenic'",
  "WHERE s.rank >= cutoff.rank",
  "ORDER BY s.rank DESC",
].join("\n");

const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1", id: "ordinal-scale-demo", version: "0.1.0",
  title: "Ordinal scale demo", description: "Threshold variants on the ACMG ordinal scale by rank.",
  domains: ["genomics"],
  provides: {
    resolvers: [{ id: "inline.table", version: "0.1.0", title: "Inline table", description: "Materialize a declared inline table.", output: { mode: "table" } }],
    resources: [{ id: "variant_calls", title: "Variant calls", kind: "virtual", resolver: "inline.table", params: { table: "variant_calls", columns: [{ name: "variant_key", type: "TEXT" }, { name: "acmg_classification", type: "TEXT" }], rows: VARIANTS } }],
    termSets: [ACMG],
    operations: [{
      schema: "pi-bio.operation_spec.v1", id: "acmg.threshold", version: "0.1.0",
      title: "ACMG threshold", description: "Variants at or above likely_pathogenic by ACMG rank.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: SQL, readOnly: true, requiredResources: ["variant_calls"] },
    }],
  },
};

async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
function freshRegistry() {
  const r = createBioRegistry();
  r.registerManifest(manifest);
  r.bindResolverImpl("inline.table", inlineTableResolver);
  return r;
}

describe("ordinal scales: a ranked TermSet is the program; SQL thresholds on rank", () => {
  test("an operation thresholds on ACMG rank via scale_members — no ACMG-specific code", async () => {
    const { result } = await runOperation(freshRegistry(), await memoryConn(), { operationId: "acmg.threshold", runId: "scale-1", now: "t" });
    // pathogenic(4) and likely_pathogenic(3) pass >= likely_pathogenic; vus(2)/benign(0) excluded — by rank
    assert.deepEqual(result.rows.map((r) => r.variant_key), ["1:1:A:T", "2:2:C:G"]);
    assert.deepEqual(result.rows.map((r) => Number(r.rank)), [4, 3]);
  });

  test("materializeScaleMembers projects every ordered TermSet into one generic table", async () => {
    const conn = await memoryConn();
    const n = await materializeScaleMembers(freshRegistry(), conn);
    assert.equal(n, 5);
    const rows = await conn.all<{ member_id: string; rank: number }>("SELECT member_id, rank FROM scale_members WHERE scale_id = 'acmg_classification' ORDER BY rank");
    assert.deepEqual(rows.map((r) => r.member_id), ["benign", "likely_benign", "vus", "likely_pathogenic", "pathogenic"]);
  });
});
