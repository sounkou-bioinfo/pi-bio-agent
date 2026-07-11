# pi-bio-workbench

`pi-bio-workbench` is an API-first scientific workbench built on `pi-bio-agent`. Applications own domain
resources, evidence relations, review policy, reports, and user-facing contracts. The substrate owns manifests,
DuckDB execution, durable checkpoints, receipts, replay, CAS, and the observation graph.

The first binding is clinical genomics. It exercises two rare-disease traversal directions over the same declared
case data:

- **Direct:** assess observed variants, retaining candidates, abstentions, and evidence conflicts.
- **Inverted:** ground an immutable case narrative to reviewed HPO assertions, derive gene/disease hypotheses, and
  inspect all case variants in each supported gene without collapsing them to one arbitrary row.

Both lanes close into the `case_evidence` relation. Reanalysis compares the shared `variant_assessment` relation
with prior state. The evidence packet contains review-bearing rows rather than every routine exclusion; the complete
relations remain available to SQL in the per-analysis DuckDB file. The SDK and CLI return that host path for local
inspection; the HTTP contract does not expose it.

This is evidence routing, not a complete clinical classification kernel. It does not claim ACMG/AMP classification,
causal diagnosis, or clinical validity beyond the declared fixture data.

## Run the binding

```sh
npm install
npm run check
npm run demo:clinical
```

One analysis checkpoints phenotype grounding, the reconciled evidence operation, reanalysis, and packet assembly.
Grounding resolves the narrative and ontology candidates through recorded manifest queries; agent augmentation,
term proposals, and review are host-injected ports. The packaged CLI uses an explicit recorded fixture, while a live
host supplies its own model or human implementations. Reusing an analysis id resumes from the durable checkpoints:

```sh
node dist/cli.js run examples/clinical-genomics CASE-RD-001 analysis-demo
node dist/cli.js run examples/clinical-genomics CASE-RD-001 analysis-demo
```

The second invocation reports zero executed steps and four reused steps. Scientific result, receipt, replay, and
run-object bytes live in CAS; checkpoints carry only their references. Reusing an analysis id after a declared input
file or grounding composition changes fails closed because the task replay digest pins both.

Pass a host module as the final argument to replace the recorded fixture. The module exports a default function or
`createGroundingRuntime({ workspace })` returning the same host-injected augmenter, proposal, and reviewer ports used
by the SDK:

```sh
node dist/cli.js run examples/clinical-genomics CASE-RD-001 analysis-live ./grounding-host.mjs
```

Compare lexical retrieval with pre-retrieval, post-initial-retrieval, and combined agent augmentation:

```sh
npm run benchmark:grounding
```

This is retrieval-contract dogfood, not a model-quality claim: recorded proposals and reviews isolate whether each
mode admits the right candidates without leaking gold to the ports. The immutable case reaches 0.75 structured-
assertion recall with lexical retrieval; each augmentation mode reaches precision and recall 1.0. The report includes
proposals, original-text spans, augmentation receipts, review decisions, per-case metrics, micro metrics, and the
recorded bootstrap run.

## Query the pinned Monarch graph

The inverted traversal can also run directly over Monarch's versioned DuckDB database. The host attaches the
snapshot read-only; the manifest then queries its canonical `edges`, `nodes`, and ontology `closure` tables. No
Monarch-specific resolver or denormalized search table is involved.

```sh
npm run dogfood:monarch
```

The checked-in query starts from four accepted HPO identifiers and returns phenotype-supported disease and gene
hypotheses with exact-match counts, ancestor/descendant match kinds, annotation specificity, association predicates,
and primary knowledge sources. A recorded run against the `2026-04-14` snapshot ranked PCDH19/DEE9 first and
SCN1A/DEE6A second. The output is a hypothesis relation for targeted variant search and review, not a diagnosis.
Result, receipts, replay spec, and run object are stored in CAS, while the ledger records the run, manifest, and
operation links.

## Run the API

```sh
npm run serve -- examples/clinical-genomics 8787
```

An optional third argument supplies the same grounding host module to the HTTP server.

```sh
curl -sS http://localhost:8787/v1/clinical-analyses \
  -H 'content-type: application/json' \
  -d '{"caseId":"CASE-RD-001"}'
```

The same Zod route schemas validate requests and generate the OpenAPI 3.1 document at
`http://localhost:8787/openapi.json`. The server fixes the clinical workspace at startup; clients cannot submit a
host path in the request, and host store paths are not part of the response contract.

The app depends on the sibling substrate through `"pi-bio-agent": "file:../pi-bio-agent"`. It consumes substrate
APIs directly and does not vendor or reimplement them.
