import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fsCasStore,
  openBioStore,
  recordArtifactReference,
  recordObservation,
  runBioQueryFromManifest,
} from "pi-bio-agent";
import {
  loadRecordedGroundingRuntime,
  runPhenotypeGroundingBenchmark,
} from "../dist/index.js";

const workspace = resolve(process.argv[2] ?? "examples/clinical-genomics");
const root = join(workspace, ".pi", "bio-agent");
const dbPath = join(root, "benchmarks", "phenotype-grounding.duckdb");
await mkdir(join(root, "benchmarks"), { recursive: true });
const ledger = await openBioStore(workspace);
const cas = fsCasStore(join(root, "cas"));

try {
  const bootstrap = await runBioQueryFromManifest({
    cwd: workspace,
    dbPath,
    manifestPath: "grounding-benchmark.json",
    runId: "grounding-benchmark.bootstrap",
    sql: `SELECT n.case_id, n.narrative, g.hpo_id, g.assertion_context, g.subject_context,
                 g.subject_id, g.evidence_text, g.start_offset, g.end_offset
          FROM case_narratives n
          JOIN grounding_gold g USING (case_id)
          ORDER BY n.case_id, g.hpo_id`,
    resources: ["case_narratives", "hpo_terms", "grounding_gold"],
    store: ledger.conn,
    author: "pi-bio-workbench:grounding-benchmark",
    cas,
    casMetadata: { conn: ledger.conn },
    serialize: false,
  });
  if (!bootstrap.ok) throw new Error(bootstrap.error);
  const db = await openBioStore(workspace, { path: dbPath });
  try {
    const runtime = await loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json"));
    const cases = new Map();
    for (const row of bootstrap.result.rows) {
      const caseId = String(row.case_id);
      const benchmarkCase = cases.get(caseId) ?? { caseId, narrative: String(row.narrative), goldAssertions: [] };
      benchmarkCase.goldAssertions.push({
        hpoId: String(row.hpo_id),
        assertionContext: String(row.assertion_context),
        subjectContext: String(row.subject_context),
        ...(row.subject_id ? { subjectId: String(row.subject_id) } : {}),
        evidenceText: String(row.evidence_text),
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
      });
      cases.set(caseId, benchmarkCase);
    }
    const report = await runPhenotypeGroundingBenchmark({
      conn: db.conn,
      suite: {
        suite: "clinical-genomics-phenotype-grounding",
        source: "grounding-benchmark.json#grounding_gold",
        version: "1",
        cases: [...cases.values()],
      },
      modes: ["none", "pre-retrieval", "post-initial-retrieval", "pre+post"],
      agent: runtime.agent,
      reviewer: runtime.reviewer,
      augmenter: runtime.augmenter,
    });
    const reportBytes = Buffer.from(JSON.stringify(report), "utf8");
    const digest = createHash("sha256").update(reportBytes).digest("hex");
    const reportDigest = `sha256:${digest}`;
    const benchmarkId = `benchmark:${report.suite.digest}:${report.provenance.generatedAt}`;
    await cas.put({ algorithm: "sha256", digest, sizeBytes: reportBytes.length, mediaType: "application/vnd.pi-bio.workbench.phenotype-benchmark+json" }, reportBytes);
    await recordObservation(ledger.conn, {
      statementKey: benchmarkId,
      subjectId: benchmarkId,
      predicate: "benchmark",
      value: { schema: report.schema, suite_digest: report.suite.digest, report_digest: reportDigest, aggregate: report.aggregate },
      recordedAt: report.provenance.generatedAt,
      source: "pi-bio-workbench:grounding-benchmark",
      digest: reportDigest,
    });
    await recordArtifactReference(ledger.conn, {
      artifact: {
        digest: reportDigest,
        mediaType: "application/vnd.pi-bio.workbench.phenotype-benchmark+json",
        semanticRole: "phenotype_grounding_benchmark",
        sizeBytes: reportBytes.length,
      },
      subjectId: benchmarkId,
      predicate: "produces",
      recordedAt: report.provenance.generatedAt,
      source: "pi-bio-workbench:grounding-benchmark",
      casMetadata: { conn: ledger.conn, refId: benchmarkId, refType: "artifact" },
    });
    console.log(JSON.stringify({
      bootstrap: { runId: bootstrap.runId, casRefs: bootstrap.casRefs },
      benchmark: { benchmarkId, reportDigest, reportUri: `cas:${reportDigest}` },
      report,
    }, null, 2));
  } finally {
    db.close();
  }
} finally {
  ledger.close();
}
