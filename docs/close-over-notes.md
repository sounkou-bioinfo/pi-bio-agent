# Close-over notes

This repo is the application split from `pi-bio-agent`. It consumes substrate primitives directly. A new substrate
primitive is warranted only when the application cannot express a concrete workflow through the existing ports.

## Clinical binding

The clinical example is one evidence task with four durable steps:

1. Phenotype grounding resolves the immutable narrative and HPO candidates through recorded manifest queries,
   runs host-injected augmentation/proposal/review ports, and stores the complete result in CAS.
2. `clinical.case_evidence` materializes accepted observations from a replay-pinned JSON binding, resolves the other
   declared SQL relations, and returns bounded review evidence
   from direct and inverted traversal.
3. `clinical.reanalysis_diff` compares the same variant-assessment semantics with declared prior state and status
   order.
4. The application builds one evidence packet, writes it to CAS, and links the case, analysis, packet, and scientific
   runs in the observation ledger.

The relations carry the domain logic:

- `variant_assessment` parses frequency once and records candidate, abstention, exclusion, missingness, and conflict.
- `phenotype_hypothesis` counts observed term matches without claiming an information-content score.
- `clinical.monarch_phenotype_hypotheses` is a separate live-source operation over a pinned Monarch DuckDB snapshot.
  It walks canonical graph tables in SQL and emits exact/ontology-related match components plus an explicit direct
  annotation-frequency statistic; it is not yet the hypothesis source used by the four-step fixture workflow.
- `case_evidence` reconciles traversal order while retaining every matching variant.
- `reanalysis_evidence` uses a declared status-order table and abstains on unknown vocabularies.

## Substrate used as-is

- `runBioOperationFromManifest` for scientific execution and run evidence.
- `runBioQueryFromManifest` for narrative and ontology candidate retrieval authored as SQL rather than direct file
  parsing.
- `runJobStepsWithCheckpoints` for prefix resume under one replay digest.
- `openBioStore` and observation links for application state and provenance.
- `CasStore` / `fsCasStore` for immutable run objects and the evidence packet.
- `duckdb.sql_materialize` for intermediate relations, including accepted phenotype observations.
- Typed session-variable bindings for passing the HPO set as a DuckDB `VARCHAR[]`, without a JSON-string transport.

The application runs with `serialize: false` and dereferences result digests through `CasStore`. It does not depend
on duplicate loose `result.json` or `receipts.json` files as an internal transport.
The complete materialized relations persist in a per-analysis DuckDB file; the packet and ledger checkpoints remain
bounded to review evidence and content references.

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

No new core primitive was required for this slice. The first concrete pressure is remote artifact retrieval, not a
new workflow engine or a generic workbench action registry.

## Repository topology

Keep the substrate and workbench in separate repositories while the workbench is proving the public consumer
surface. The sibling file dependency and pinned two-repository CI provide fast local development without hiding an
accidental internal API. Reconsider a monorepo only when ordinary features repeatedly require atomic commits and
lockstep releases across both repositories; this grounding slice required no core code change.

Execution policy remains host-owned. Trusted local scientific work can use the unrestricted host ports directly.
Gondolin or another isolation backend is an optional `ComputeRunner`/host composition for untrusted generated code,
sensitive credentials, or multi-tenant deployment, not a core or workbench dependency.
