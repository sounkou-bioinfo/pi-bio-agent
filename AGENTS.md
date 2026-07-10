# AGENTS.md

Instructions for coding agents working in this repository.

## Product And Dependency Direction

- `pi-bio-workbench` is the application layer over the sibling `pi-bio-agent` substrate. It owns scientific
  workflows, manifests, domain relations, typed proposals, review policy, evidence packets, APIs, and user-facing
  surfaces. `pi-bio-agent` owns execution, durable jobs/checkpoints, CAS, receipts, replay, graph/memory primitives,
  and host-injected effects.
- Keep the dependency one-way through `file:../pi-bio-agent` during development. Do not vendor, fork, or reimplement
  substrate behavior in this repository. A genuine missing primitive is fixed in core; application composition stays
  here.
- This is pre-1.0 work with no compatibility obligation to toy or unclear surfaces. Prefer replacing a false model
  over preserving it behind adapters.
- The model is an agent over scientific apparatus, not the source of biomedical facts. Facts come from declared
  case data, ontologies, knowledge graphs, annotation sources, deterministic computation, receipts, and approved
  judgments.

## Clinical Traversals

- Direct and inverted are traversal orders over shared evidence, not separate clinical kernels.
- Direct starts from case variants and applies declared annotation, frequency, consequence, inheritance, and
  evidence rules.
- Inverted starts from the case narrative, grounds phenotype assertions, walks phenotype/disease/gene relations,
  and uses the resulting gene hypotheses to select which parts of the case variant set need annotation. Both lanes
  must converge on compatible candidate-variant/disease evidence relations.
- Do not introduce a dedicated phenotype-mapper service, mandatory grounding package, or per-question skill.
  Compose declared ontology label/synonym relations, DuckDB FTS or ordinary SQL, `pi-bio-agent` term sets and typed
  grounding validation, graph projection/closure, Monarch phenotype/disease/gene evidence, `duckhts` indexed range
  reads, and DuckDB SQL scoring. A separate grounding implementation is optional only after measured retrieval or
  reranking failures justify it.

## Inverted Lane: Established Composition

Treat the following as the implementation baseline, not a question to re-derive:

1. Record the case narrative as a declared, content-addressed input.
2. Materialize HPO labels and synonyms from a declared ontology source. Let the agent inspect/query those relations
   with DuckDB FTS or ordinary SQL, build real candidate `TermSet`s, and submit typed proposals through deterministic
   no-invented-identifier validation. The application validates quoted source spans and records subject,
   presence/absence, uncertainty, family context, offsets, ontology version/digest, proposal, and approval. Do not
   discard negative or uncertain observations during grounding.
3. Walk HPO/MONDO and a pinned Monarch graph projection to produce disease/gene hypotheses and explicit score
   components. Query graph relations in DuckDB; do not serialize large graph neighborhoods into prompts.
4. Resolve candidate genes to assembly-pinned genomic intervals. Use indexed `duckhts` range reads against the case
   VCF/BCF, deduplicate variants from overlapping intervals, and retain the gene/phenotype selection reason.
5. Normalize and batch the selected variants for Ensembl VEP `/region`, at most 200 variants per request. Reuse
   `pi-bio-agent/src/duckdb/ncurl-fanout.ts`: it already provides bounded AIO fanout, transient retry, backoff,
   cancellation, and terminal failure reporting. The live precedent is
   `pi-bio-agent/examples/wgs-chr22-annotation/live.mjs`; single-endpoint and host-fetch retry policies also already
   exist in core. Do not design another rate-limit layer.
6. Materialize VEP response rows and join them to phenotype, disease, gene, inheritance, frequency, ClinVar, and
   other declared evidence. Pin request inputs and returned scientific rows through run receipts/CAS.
7. Send only the reduced candidate relation to literature retrieval and typed, gated assessment. The complete
   relations remain queryable even when an evidence packet is bounded.

An orchestrating agent may delegate grounding, graph expansion, annotation review, and literature assessment to
subagents. Subagents coordinate through DuckDB relations, CAS references, checkpoints, and ledger observations, not
private prose state. One durable annotation step owns network batching so parallel agents do not duplicate effects.

## Coverage And Clinical Honesty

- Pin the reference assembly at every interval and VEP step. A build mismatch is a failed run, not a warning.
- Record candidate-gene and interval coverage: genes proposed, genes scanned, intervals read, variants observed,
  variants submitted, variants annotated, failures, and exclusions. A variant outside the selected scope is "not
  searched by this traversal," not negative evidence.
- Test overlapping genes/intervals, multiallelic records, normalization, transcript multiplicity, missing frequency,
  inheritance, and retry/resume behavior. SV/CNV, breakends, repeats, mitochondrial variants, and distant regulatory
  effects need explicit supported/unsupported coverage rather than being silently treated as ordinary SNVs.
- Online VEP is the targeted path. When the selected set exceeds the admitted online budget or the endpoint is
  unavailable, fail or route to a declared local VEP/`duckvep` compute path. Never truncate silently.
- Candidate selection can miss novel genes or phenocopies. The direct lane is the complementary search, and reports
  must state the scope of each traversal rather than presenting one lane as exhaustive.

## Current Implementation Debt

- The inverted lane now consumes reviewed, original-span-grounded phenotype observations. Its HPO vocabulary,
  recorded proposal/review ports, and benchmark gold are still hermetic fixtures; they prove orchestration and
  failure behavior, not real-world grounding accuracy.
- `examples/clinical-genomics/data/gene_phenotype.csv` and the current exact-match count in
  `relations/phenotype_hypothesis.sql` are orchestration fixtures, not a defensible phenotype-ranking method. Replace
  them with a pinned real graph projection, ontology-aware matching/information content, and explicit score columns.
- `inverted_gap` is too coarse as a scientific label. A phenotype-supported gene with no selected supporting variant
  means missing genotype support within the recorded search scope; it does not mean the gene was ruled out.
- Keep hermetic CI fixtures, but generate or validate them against recorded real-source dogfood. Do not cite fixture
  success as proof of clinical validity.

## API And Workflow Discipline

- Keep the API schema-first: Zod schemas are runtime validation and the source of OpenAPI. Do not maintain a second
  hand-written API specification.
- HTTP clients must not choose host filesystem paths, credentials, extension policy, or arbitrary execution
  settings. Those belong to host composition.
- Preserve task -> step -> checkpoint semantics. Resume from content-pinned completed steps; changed scientific
  inputs must invalidate reuse. Checkpoints carry CAS references rather than duplicating result rows.
- Every scientific operation should follow manifest/operation -> resolver or injected port -> DuckDB relation ->
  recorded run -> CAS/receipts -> observations. Call out any deliberate bypass as integration debt.

## Checks

- Use `rg` for repository search and `apply_patch` for manual edits.
- Run `npm run check` after manifest, workflow, API, or relation changes.
- Run the real dogfood relevant to a claim. Unit fixtures prove contracts and edge handling; they do not prove live
  source compatibility, rate behavior, graph coverage, or scientific validity.
- Review substantial changes with the reusable Pi review session described in `../pi-bio-agent/AGENTS.md`.
