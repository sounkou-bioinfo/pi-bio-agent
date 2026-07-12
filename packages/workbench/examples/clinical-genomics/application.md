# Clinical genomics evidence application


This is an executable downstream application of `pi-bio-agent`, not a
proposed core workflow. It composes the workbench’s declared relations
into two traversal lanes over one case:

- **direct** starts from observed variants and retains candidates,
  abstentions, and evidence conflicts;
- **inverted** grounds the case narrative, walks phenotype/disease/gene
  relations, resolves assembly-pinned intervals, reads only those
  indexed VCF regions, and annotates selected alleles.

Both lanes materialize into `case_evidence`. The application owns
phenotype policy, coverage semantics, ranking, review items, and the
evidence packet. Core supplies manifest execution, DuckDB
materialization, bounded HTTP fanout, checkpoints, CAS, replay, and
observations.

## Hermetic host composition

The executable document uses recorded grounding, a local Monarch-shaped
fixture, an indexed VCF fixture, and a local VEP-compatible HTTP server.
The server deliberately returns two `503` responses before succeeding,
exercising the generic DuckNNG fanout/retry path without relying on a
live endpoint.

``` ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runClinicalGenomicsWorkbench } from "../../dist/clinical-genomics.js";
import { localCandidateVariantSearchRuntime } from "../../dist/candidate-variant-search.js";
import { localMonarchFixtureRuntime } from "../../dist/monarch-host.js";
import { loadRecordedGroundingRuntime } from "../../dist/recorded-grounding.js";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-clinical-application-"));
await fs.cp(sourceDir, workspace, {
  recursive: true,
  filter: (source) => relative(sourceDir, source).split(sep)[0] !== ".pi",
});

const annotations = {
  "17-43093464-A-T": { gene: "GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.0002, significance: "pathogenic" },
  "17-43093470-C-G": { gene: "GENEB", consequence: "missense_variant", impact: "MODERATE", af: 0.0003, significance: "uncertain_significance" },
  "17-43093470-C-T": { gene: "GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.02, significance: "benign" },
};

let requests = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  requests += 1;
  if (request.method !== "POST" || request.url !== "/vep") {
    response.writeHead(404).end();
    return;
  }
  if (requests <= 2) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "transient_fixture_failure" }));
    return;
  }
  const variants = JSON.parse(Buffer.concat(chunks).toString("utf8")).variants;
  const rows = variants.map((input) => {
    const [chrom, pos, _dot, ref, alt] = input.split(" ");
    const key = `${chrom}-${pos}-${ref}-${alt}`;
    const item = annotations[key];
    return {
      input,
      most_severe_consequence: item.consequence,
      transcript_consequences: [{ gene_symbol: item.gene, impact: item.impact, consequence_terms: [item.consequence] }],
      colocated_variants: [{ id: key, clin_sig: [item.significance], frequencies: { [alt]: { gnomadg: item.af } } }],
    };
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(rows));
});
await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address !== "string");

const runtime = {
  url: `http://127.0.0.1:${address.port}/vep`,
  headersJson: '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]',
  sourceId: "fixture:vep",
  sourceVersion: "fixture-1",
  duckdbInitSql: ["LOAD ducknng"],
};

const run = async (now) => runClinicalGenomicsWorkbench({
  exampleDir: workspace,
  caseId: "CASE-RD-001",
  analysisId: "application-proof",
  now,
  grounding: await loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json")),
  hypotheses: localMonarchFixtureRuntime(workspace),
  variantSearch: localCandidateVariantSearchRuntime(workspace),
  vep: runtime,
});
```

## Execute and resume

``` ts
let first;
let resumed;
try {
  first = await run("2026-07-12T12:00:00Z");
  resumed = await run("2026-07-12T12:05:00Z");
} finally {
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

assert.equal(first.workflow.executedSteps, 8);
assert.equal(first.workflow.reusedSteps, 0);
assert.equal(resumed.workflow.executedSteps, 0);
assert.equal(resumed.workflow.reusedSteps, 8);
assert.equal(resumed.packetDigest, first.packetDigest);
assert.equal(requests, 3, "resume must reuse the VEP checkpoint");

assert.equal(first.packet.summary.directCandidates, 1);
assert.equal(first.packet.summary.directAbstentions, 1);
assert.equal(first.packet.summary.resolvedCandidateGenes, 2);
assert.equal(first.packet.summary.selectedAlleles, 3);
assert.equal(first.packet.summary.invertedSupportedHypotheses, 1);
assert.equal(first.packet.summary.invertedGaps, 1);
assert.equal(first.packet.summary.conflicts, 1);

const direct = first.packet.lanes.direct.rows;
assert.equal(direct.find((row) => row.variant_key === "2-47637258-C-CT")?.variant_bucket, "abstain_no_frequency");
const inverted = first.packet.lanes.inverted.rows;
assert.equal(
  inverted.find((row) => row.gene === "GENEB" && row.evidence_status === "genotype_supports_hypothesis")?.vep_consequence,
  "stop_gained",
);

piBio.json({
  application: "clinical-genomics",
  workflow: {
    first: { executedSteps: first.workflow.executedSteps, reusedSteps: first.workflow.reusedSteps },
    resumed: { executedSteps: resumed.workflow.executedSteps, reusedSteps: resumed.workflow.reusedSteps },
    replayDigestStableWithinAnalysis: resumed.workflow.replayDigest === first.workflow.replayDigest,
    packetDigestStable: resumed.packetDigest === first.packetDigest,
    vepRequestsIncludingRetries: requests,
  },
  evidence: first.packet.summary,
  provenance: {
    runCount: first.packet.provenance.runIds.length,
    packetStoredInCas: first.packetUri.startsWith("cas:sha256:"),
  },
});
```

<details class="pi-bio-output">

<summary>

Output: cell-2
</summary>

``` json
{
  "application": "clinical-genomics",
  "workflow": {
    "first": {
      "executedSteps": 8,
      "reusedSteps": 0
    },
    "resumed": {
      "executedSteps": 0,
      "reusedSteps": 8
    },
    "replayDigestStableWithinAnalysis": true,
    "packetDigestStable": true,
    "vepRequestsIncludingRetries": 3
  },
  "evidence": {
    "directCandidates": 1,
    "directAbstentions": 1,
    "phenotypeHypotheses": 2,
    "resolvedCandidateGenes": 2,
    "unresolvedCandidateGenes": 0,
    "searchedCandidateGenes": 2,
    "unsearchedCandidateGenes": 0,
    "selectedAlleles": 3,
    "invertedSupportedHypotheses": 1,
    "invertedGaps": 1,
    "invertedUnsearched": 0,
    "conflicts": 1,
    "reanalysisSignals": 1,
    "reviewQueue": [
      {
        "kind": "confirm_candidate",
        "target": "variant:17-43093464-A-T",
        "reason": "17-43093464-A-T passed the declared variant screen and has curated pathogenicity evidence; confirmation remains review-bound."
      },
      {
        "kind": "review_conflict",
        "target": "variant:3-300-C-T",
        "reason": "3-300-C-T has conflicting curated and predicted consequence evidence."
      },
      {
        "kind": "resolve_frequency",
        "target": "variant:2-47637258-C-CT",
        "reason": "2-47637258-C-CT has no usable allele frequency and was not called rare."
      },
      {
        "kind": "correlate_supported_hypothesis",
        "target": "hypothesis:MONDO:GENEB:GENEB",
        "reason": "GENEB has both phenotype and screened genotype support; their case-level fit requires review."
      },
      {
        "kind": "review_missing_genotype_support",
        "target": "hypothesis:MONDO:GENEH:GENEH",
        "reason": "GENEH is phenotype-supported, but no supporting variant was found within the recorded search scope; this is missing genotype support, not evidence against the hypothesis."
      },
      {
        "kind": "review_conflict",
        "target": "hypothesis:MONDO:GENEB:GENEB",
        "reason": "17-43093470-C-T has conflicting curated and predicted consequence evidence."
      },
      {
        "kind": "reanalysis_signal",
        "target": "variant:17-43093464-A-T",
        "reason": "17-43093464-A-T is upgraded relative to the prior assessment."
      }
    ],
    "kernelScope": "evidence routing only; not a complete clinical classification kernel"
  },
  "provenance": {
    "runCount": 9,
    "packetStoredInCas": true
  }
}
```

</details>

## What the application establishes

The run establishes that the public substrate can support an application
with grounded inputs, foreign-graph queries, indexed range reads,
bounded network retry, SQL reconciliation, eight durable checkpoints, a
CAS-backed packet, and exact resume. It also preserves an important
abstention: missing population frequency is not evidence that a variant
is rare.

It does not establish ACMG/AMP classification, diagnosis, clinical
validity, or live-source stability. Those are application evaluation and
review concerns.

## How applications change core

This application is an abstraction pressure surface. The correct
movement is:

1.  keep domain policy in its SQL relations and host composition;
2.  note repeated friction while adding another application or generic
    pattern;
3.  identify the common policy-free motion;
4.  promote only that primitive to core with tests;
5.  return this application to the public API and remove the workaround.

Bounded DuckNNG HTTP fanout followed that path. Phenotype ranking,
variant-search coverage, and clinical evidence states have not repeated
elsewhere and remain here.
