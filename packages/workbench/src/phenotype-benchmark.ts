import { canonicalDigest, type SqlConn } from "pi-bio-agent";
import {
  GROUNDING_MODES,
  narrativeDigest,
  runPhenotypeGrounding,
  sqlPhenotypeCandidateRetriever,
  type GroundingAgentPort,
  type GroundingAugmentation,
  type GroundingAugmenterPort,
  type GroundingMode,
  type GroundingReviewerPort,
  type PhenotypeObservation,
} from "./phenotype-grounding.js";

export const PHENOTYPE_BENCHMARK_SCHEMA = "pi-bio.workbench.phenotype_benchmark.v1" as const;

export interface PhenotypeBenchmarkCase {
  caseId: string;
  narrative: string;
  goldAssertions: PhenotypeBenchmarkAssertion[];
}

export type PhenotypeBenchmarkAssertion = Pick<
  PhenotypeObservation,
  "hpoId" | "assertionContext" | "subjectContext" | "subjectId" | "evidenceText" | "startOffset" | "endOffset"
>;

export interface PhenotypeBenchmarkSuite {
  suite: string;
  source: string;
  version: string;
  cases: PhenotypeBenchmarkCase[];
}

export interface BenchmarkMetrics {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface PhenotypeBenchmarkPrediction {
  caseId: string;
  mode: GroundingMode;
  predictedIds: string[];
  predictedAssertions: PhenotypeBenchmarkAssertion[];
  observations: PhenotypeObservation[];
  augmentations: GroundingAugmentation[];
  rejected: Array<{ proposalId: string; reason: string }>;
  metrics: BenchmarkMetrics;
  timingsMs: { augmentation: number; retrieval: number; proposal: number; review: number; total: number };
}

export interface PhenotypeBenchmarkReport {
  schema: typeof PHENOTYPE_BENCHMARK_SCHEMA;
  suite: { name: string; source: string; version: string; digest: string };
  modes: GroundingMode[];
  predictions: PhenotypeBenchmarkPrediction[];
  aggregate: Record<GroundingMode, BenchmarkMetrics>;
  provenance: {
    generatedAt: string;
    runtime: string;
    platform: string;
    architecture: string;
    ontologyDigest: string;
    caseCount: number;
  };
}

function metricsFromCounts(truePositive: number, falsePositive: number, falseNegative: number): BenchmarkMetrics {
  const precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { truePositive, falsePositive, falseNegative, precision, recall, f1 };
}

export function groundingMetrics(predicted: readonly string[], gold: readonly string[]): BenchmarkMetrics {
  const predictedSet = new Set(predicted);
  const goldSet = new Set(gold);
  let truePositive = 0;
  for (const id of predictedSet) if (goldSet.has(id)) truePositive++;
  return metricsFromCounts(truePositive, predictedSet.size - truePositive, goldSet.size - truePositive);
}

function assertionKey(assertion: PhenotypeBenchmarkAssertion): string {
  return canonicalDigest({
    hpoId: assertion.hpoId,
    assertionContext: assertion.assertionContext,
    subjectContext: assertion.subjectContext,
    subjectId: assertion.subjectId ?? null,
    evidenceText: assertion.evidenceText,
    startOffset: assertion.startOffset,
    endOffset: assertion.endOffset,
  });
}

export async function runPhenotypeGroundingBenchmark(args: {
  conn: SqlConn;
  suite: PhenotypeBenchmarkSuite;
  agent: GroundingAgentPort;
  reviewer: GroundingReviewerPort;
  augmenter?: GroundingAugmenterPort;
  modes?: GroundingMode[];
  generatedAt?: string;
}): Promise<PhenotypeBenchmarkReport> {
  if (!args.suite.suite || !args.suite.source || !args.suite.version || !args.suite.cases.length) {
    throw new Error("benchmark suite requires suite/source/version and at least one case");
  }
  const modes = args.modes ?? [...GROUNDING_MODES];
  const predictions: PhenotypeBenchmarkPrediction[] = [];
  const retriever = sqlPhenotypeCandidateRetriever(args.conn);
  for (const benchmarkCase of args.suite.cases) {
    if (!benchmarkCase.caseId || !benchmarkCase.narrative || !Array.isArray(benchmarkCase.goldAssertions)) {
      throw new Error("benchmark cases require caseId, narrative, and goldAssertions");
    }
    for (const mode of modes) {
      // Gold is read only after prediction; it is absent from every injected port input.
      const result = await runPhenotypeGrounding({
        narrative: {
          caseId: benchmarkCase.caseId,
          text: benchmarkCase.narrative,
          sourceDigest: narrativeDigest(benchmarkCase.narrative),
        },
        mode,
        retriever,
        agent: args.agent,
        reviewer: args.reviewer,
        ...(args.augmenter ? { augmenter: args.augmenter } : {}),
      });
      const predictedIds = [...new Set(result.accepted.map(({ hpoId }) => hpoId))].sort();
      const predictedAssertions = result.accepted.map((observation) => ({
        hpoId: observation.hpoId,
        assertionContext: observation.assertionContext,
        subjectContext: observation.subjectContext,
        ...(observation.subjectId ? { subjectId: observation.subjectId } : {}),
        evidenceText: observation.evidenceText,
        startOffset: observation.startOffset,
        endOffset: observation.endOffset,
      }));
      predictions.push({
        caseId: benchmarkCase.caseId,
        mode,
        predictedIds,
        predictedAssertions,
        observations: result.accepted,
        augmentations: result.augmentations,
        rejected: result.rejected,
        metrics: groundingMetrics(predictedAssertions.map(assertionKey), benchmarkCase.goldAssertions.map(assertionKey)),
        timingsMs: result.timingsMs,
      });
    }
  }
  const aggregate = Object.fromEntries(modes.map((mode) => {
    const counts = predictions.filter((prediction) => prediction.mode === mode).reduce(
      (sum, prediction) => ({
        truePositive: sum.truePositive + prediction.metrics.truePositive,
        falsePositive: sum.falsePositive + prediction.metrics.falsePositive,
        falseNegative: sum.falseNegative + prediction.metrics.falseNegative,
      }),
      { truePositive: 0, falsePositive: 0, falseNegative: 0 },
    );
    return [mode, metricsFromCounts(counts.truePositive, counts.falsePositive, counts.falseNegative)];
  })) as Record<GroundingMode, BenchmarkMetrics>;
  const ontologyRows = await args.conn.all<Record<string, unknown>>(
    "SELECT hpo_id, label, synonym, ontology_source, ontology_version, ontology_digest FROM hpo_terms ORDER BY hpo_id, synonym",
  );
  return {
    schema: PHENOTYPE_BENCHMARK_SCHEMA,
    suite: {
      name: args.suite.suite,
      source: args.suite.source,
      version: args.suite.version,
      digest: canonicalDigest(args.suite),
    },
    modes,
    predictions,
    aggregate,
    provenance: {
      generatedAt: args.generatedAt ?? new Date().toISOString(),
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      ontologyDigest: canonicalDigest(ontologyRows),
      caseCount: args.suite.cases.length,
    },
  };
}
