# Close-over notes

This repo is the application split from `pi-bio-agent`. It consumes substrate primitives directly. A new substrate
primitive is warranted only when the application cannot express a concrete workflow through the existing ports.

## Clinical binding

The clinical example is one evidence task with eight durable steps:

1. Phenotype grounding resolves the immutable narrative and HPO candidates through recorded manifest queries,
   runs host-injected augmentation/proposal/review ports, and stores the complete result in CAS.
2. `clinical.monarch_phenotype_hypotheses` walks canonical graph `edges`, `nodes`, and ontology `closure`, then stores
   the ranked hypothesis relation and complete run evidence in CAS.
3. Candidate hypotheses resolve to assembly-pinned intervals.
4. The indexed case-VCF search records coverage and selected alleles.
5. The `vep_http_results` resource declares 200-allele batch SQL and uses the generic `ducknng.http_fanout`
   resolver, which closes over core `ncurlFanout` launch/drain/retry/cancel. `clinical.vep_annotations` uses ordinary
   SQL over the response table; normalized rows are checkpointed in CAS.
6. `clinical.reanalysis_diff` consumes the VEP checkpoint through protected bindings.
7. `clinical.case_evidence` materializes the current assessment and both traversal lanes.
8. The application builds one evidence packet, writes it to CAS, and links the case, analysis, packet, and scientific
   runs in the observation ledger.

The relations carry the domain logic:

- `variant_assessment` parses frequency once and records candidate, abstention, exclusion, missingness, and conflict.
- `clinical.monarch_phenotype_hypotheses` emits exact/ontology-related match components, association sources, and an
  explicit direct annotation-frequency statistic. The workflow uses the same operation for the canonical fixture and
  pinned Monarch sources.
- `phenotype_hypothesis` validates and materializes the bounded CAS-backed handoff for evidence reconciliation.
- `variant_search_coverage` distinguishes completed gene scopes from hypotheses not yet searched; absence of a case
  variant becomes missing genotype support only after completed coverage.
- `case_evidence` reconciles traversal order while retaining every matching variant.
- `reanalysis_evidence` uses a declared status-order table and abstains on unknown vocabularies.

## Substrate used as-is

- `runBioOperationFromManifest` for scientific execution and run evidence.
- `runBioQueryFromManifest` for narrative and ontology candidate retrieval authored as SQL rather than direct file
  parsing.
- `runJobStepsWithCheckpoints` for prefix resume under one replay digest.
- `openBioStore` and observation links for application state and provenance.
- `CasStore` / `fsCasStore` for immutable run objects and the evidence packet.
- `duckdb.sql_materialize` for graph slices, ranked hypotheses, and evidence relations.
- Typed session-variable bindings for passing the HPO set as a DuckDB `VARCHAR[]`, without a JSON-string transport.

The application runs with `serialize: false` and dereferences result digests through `CasStore`. It does not depend
on duplicate loose `result.json` or `receipts.json` files as an internal transport.
The complete materialized relations persist in a per-analysis DuckDB file; packet and workflow checkpoints remain
bounded to review evidence and content references. The task replay digest covers the graph manifest, host attachment
configuration, and local fixture bytes, so changed graph inputs cannot reuse stale checkpoints.

## Current application limits

- The local API host uses filesystem CAS. A production remote artifact host will need a concrete read-capable
  artifact adapter instead of assuming local `pathFor` access.
- The API executes this short fixture task inline. A background scheduler should be introduced only with the first
  workflow whose latency requires submit/status/cancel at the application boundary; core already exposes the async
  runner lifecycle.
- The fixture does not establish a clinical classifier. Carrier guards, SNV/CNV reconciliation, dosage evidence,
  loss-of-function entry gates, family QC, and a validated phenotype semantic-similarity method remain application
  work. The Monarch operation's annotation-frequency statistic is an explicit ranking component, not validation of
  a clinical ranking method.
- Negative, uncertain, and family-context phenotype assertions remain in the grounding CAS artifact but are not yet
  scoring inputs to the Monarch operation.
- The VEP binding is a 200-allele batch composition over `ducknng.http_fanout`, including core bounded concurrency,
  transient retry, and cancellation cleanup. The app must not add a VEP-specific HTTP client.

The repeated batch transport in the application did reveal one reusable core primitive: the generic
`ducknng.http_fanout` resolver over the existing `ncurlFanout` lifecycle. The next concrete work is application SQL
for evidence and review, not another workflow engine, action registry, or HTTP client.

## Repository topology

The long-term shape can follow `pi`/`pi-mono`: one workspace with independently named `packages/agent` and
`packages/workbench`, shared checks, and lockstep release tooling. The package boundary remains real inside that
workspace: the workbench imports the agent package, never its source internals. Until that migration is worth doing,
the two GitHub repositories and a pinned package dependency keep the public consumer surface honest; a local sibling
or link is only the lockstep development override.

Execution policy remains host-owned. Trusted local scientific work can use the unrestricted host ports directly.
Gondolin or another isolation backend is an optional `ComputeRunner`/host composition for untrusted generated code,
sensitive credentials, or multi-tenant deployment, not a core or workbench dependency.
