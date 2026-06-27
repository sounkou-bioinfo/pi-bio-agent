import { defineBioOperationSpec, type BioOperationSpec } from "../core/operation-spec.js";
import type { BioRegistry, BioResolverImpl, BioResolverSpec, BioViewDef, DomainPackManifest, SourceSnapshot, SqlConn, TermSet } from "../core/manifest.js";
import type { ResourceHandle } from "../core/resources.js";
import { appendRunEvent, newRunRecord, type BioRunRecord, type BioRunSpec } from "../core/run-spec.js";
import type { BioArtifact } from "../core/types.js";

// Flagship operation pack (manifest #1). It answers "how many rare high-impact variants?" the thesis way:
// a registered resolver materializes a view, a registered SQL operation classifies it (abstaining on
// unknown frequency), and the output is a report + run record + provenance — no skill, no core helper,
// no hidden policy.

const LOF_TERMSET: TermSet = {
  id: "so.loss_of_function",
  title: "Loss-of-function sequence consequences",
  members: [
    { id: "SO:0001587", label: "stop_gained" },
    { id: "SO:0001589", label: "frameshift_variant" },
  ],
};

const ANNOTATED_VARIANTS_VIEW: BioViewDef = {
  id: "annotated_variants.v1",
  name: "annotated_variants",
  description: "Per-variant consequence + population frequency + clinical significance.",
  columns: [
    { name: "variant_key", type: "TEXT" },
    { name: "consequence", type: "TEXT", description: "SO CURIE" },
    { name: "allele_frequency", type: "DOUBLE", nullable: true, description: "population AF; NULL = unknown, NOT rare" },
    { name: "clinical_significance", type: "TEXT", nullable: true },
  ],
};

const RESOLVER: BioResolverSpec = {
  id: "fixture.annotated_variants",
  version: "0.1.0",
  title: "Synthetic annotated variants",
  description: "Materializes a tiny synthetic annotated_variants table for the flagship.",
  output: { mode: "table", schemaRef: "annotated_variants.v1" },
  temporal: { kind: "snapshot", source: "synthetic-fixture" },
};

// One synthetic variant per outcome bucket — exercises every count and the abstention.
const FIXTURE_VARIANTS = [
  { variant_key: "1:100:A:T", consequence: "SO:0001587", allele_frequency: 0.0001, clinical_significance: "Pathogenic" }, // included: rare LoF, freq known, not benign
  { variant_key: "1:200:C:G", consequence: "SO:0001587", allele_frequency: null, clinical_significance: null }, // excluded: no frequency (abstain)
  { variant_key: "1:300:G:A", consequence: "SO:0001589", allele_frequency: 0.0002, clinical_significance: "Benign" }, // excluded: benign LoF
  { variant_key: "1:400:T:C", consequence: "SO:0001583", allele_frequency: 0.2, clinical_significance: null }, // excluded: not high-impact (missense)
];

// Classification SQL lives in the operation spec (declared data), not in core. `{{lof}}` is expanded by the
// runner from the registered term set, so the LoF vocabulary is data too.
const RARE_HIGH_IMPACT_SQL = [
  "SELECT variant_key, consequence, allele_frequency,",
  "  CASE",
  "    WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "    WHEN consequence NOT IN ({{lof}}) THEN 'not_high_impact'",
  "    WHEN clinical_significance = 'Benign' THEN 'benign'",
  "    WHEN allele_frequency < 0.01 THEN 'included'",
  "    ELSE 'not_rare'",
  "  END AS bucket",
  "FROM annotated_variants ORDER BY variant_key",
].join("\n");

const OPERATION: BioOperationSpec = defineBioOperationSpec({
  schema: "pi-bio.operation_spec.v1",
  id: "rare_high_impact.report",
  version: "0.1.0",
  title: "Rare high-impact variant report",
  description: "Classify annotated variants into rare high-impact, abstaining on unknown frequency.",
  domains: ["genomics"],
  transport: "duckdb.sql",
  inputSchema: { type: "object" },
  sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredViews: ["annotated_variants"] },
});

export const rareHighImpactManifest: DomainPackManifest = {
  id: "rare-high-impact-variants",
  version: "0.1.0",
  title: "Rare high-impact variants",
  description: "Flagship pack: count frequency-known rare loss-of-function variants with explicit abstention.",
  domains: ["genomics"],
  provides: { termSets: [LOF_TERMSET], views: [ANNOTATED_VARIANTS_VIEW], resolvers: [RESOLVER], operations: [OPERATION] },
};

/** Bound at runtime by a host — never carried in the manifest. */
export const rareHighImpactResolverImpl: BioResolverImpl = async (query, ctx) => {
  const resolvedAt = ctx.now ?? new Date().toISOString();
  await ctx.conn.run("CREATE TABLE annotated_variants (variant_key TEXT, consequence TEXT, allele_frequency DOUBLE, clinical_significance TEXT)");
  for (const v of FIXTURE_VARIANTS) {
    await ctx.conn.run("INSERT INTO annotated_variants VALUES (?, ?, ?, ?)", [v.variant_key, v.consequence, v.allele_frequency, v.clinical_significance]);
  }
  const sourceSnapshots: SourceSnapshot[] = [{ source: "synthetic-fixture", version: "0.1.0", retrievedAt: resolvedAt }];
  const result: ResourceHandle = {
    schema: "pi-bio.resource_handle.v1",
    mode: "reference",
    name: "annotated_variants",
    pointer: { uri: "duckdb:table:annotated_variants", format: "table" },
  };
  return {
    schema: "pi-bio.resolution_receipt.v1",
    resolverId: RESOLVER.id,
    resolverVersion: RESOLVER.version,
    resolvedAt,
    query,
    sourceSnapshots,
    result,
    provenance: [{ source: `${RESOLVER.id}@${RESOLVER.version}`, retrievedAt: resolvedAt, notes: ["materialized synthetic annotated_variants"] }],
  };
};

export interface RareHighImpactReport {
  schema: "pi-bio.rare_high_impact_report.v1";
  operationId: string;
  runId: string;
  sourceSnapshots: SourceSnapshot[];
  counts: { totalVariants: number; includedRareHighImpact: number; excludedNoFrequency: number; excludedNotHighImpact: number; excludedBenign: number };
  included: Array<{ variantKey: string; consequence: string; alleleFrequency: number; evidence: SourceSnapshot[] }>;
  excluded: Array<{ variantKey: string; reason: string }>;
  caveats: string[];
}

/** Resolve the view, run the registered operation SQL, and emit report + run record. `now`/`runId` are injected for determinism. */
export async function runRareHighImpact(registry: BioRegistry, conn: SqlConn, opts: { runId: string; now: string }): Promise<{ report: RareHighImpactReport; run: BioRunRecord; receipt: Awaited<ReturnType<BioResolverImpl>> }> {
  const { runId, now } = opts;
  const receipt = await registry.resolve(RESOLVER.id, {}, { conn, now });

  const op = registry.getOperation("rare_high_impact.report");
  if (!op?.sql) throw new Error("operation rare_high_impact.report is not registered");
  const lof = registry.getTermSet("so.loss_of_function");
  if (!lof) throw new Error("term set so.loss_of_function is not registered");
  const ids = lof.members.map((m) => m.id);
  const sql = op.sql.sqlTemplate.replace("{{lof}}", ids.map(() => "?").join(", "));
  const rows = await conn.all<{ variant_key: string; consequence: string; allele_frequency: number | null; bucket: string }>(sql, ids);

  const bucket: Record<string, number> = {};
  const included: RareHighImpactReport["included"] = [];
  const excluded: RareHighImpactReport["excluded"] = [];
  for (const r of rows) {
    bucket[r.bucket] = (bucket[r.bucket] ?? 0) + 1;
    if (r.bucket === "included") included.push({ variantKey: r.variant_key, consequence: r.consequence, alleleFrequency: Number(r.allele_frequency), evidence: receipt.sourceSnapshots });
    else excluded.push({ variantKey: r.variant_key, reason: r.bucket });
  }
  const report: RareHighImpactReport = {
    schema: "pi-bio.rare_high_impact_report.v1",
    operationId: op.id,
    runId,
    sourceSnapshots: receipt.sourceSnapshots,
    counts: {
      totalVariants: rows.length,
      includedRareHighImpact: bucket.included ?? 0,
      excludedNoFrequency: bucket.no_frequency ?? 0,
      excludedNotHighImpact: bucket.not_high_impact ?? 0,
      excludedBenign: bucket.benign ?? 0,
    },
    included,
    excluded,
    caveats: [
      "Variants without frequency data are not counted as rare.",
      "Benign loss-of-function variants are excluded.",
      "Counts come from a registered SQL operation over a registered view, not a fixed skill.",
    ],
  };

  const reportArtifact: BioArtifact = {
    kind: "artifact",
    role: "report",
    path: `runs/${runId}/rare_high_impact.json`,
    format: "json",
    provenance: [
      { source: op.id, notes: ["operation"] },
      { source: `${receipt.resolverId}@${receipt.resolverVersion}`, retrievedAt: receipt.resolvedAt, notes: ["resolver receipt"] },
    ],
  };
  const runSpec: BioRunSpec = {
    schema: "pi-bio.run_spec.v1",
    id: runId,
    title: "Rare high-impact variants report",
    description: "Count frequency-known rare LoF variants over annotated_variants.",
    tool: { name: op.id, version: op.version },
    mode: "inline",
    inputs: [],
  };
  let run = newRunRecord(runSpec, now);
  run = appendRunEvent(run, { type: "started", at: now });
  run = appendRunEvent(run, { type: "artifact", at: now, artifacts: [reportArtifact] });
  run = appendRunEvent(run, { type: "completed", at: now, message: "report produced", data: { counts: report.counts, resolver: { id: receipt.resolverId, resolvedAt: receipt.resolvedAt } } });

  return { report, run, receipt };
}
