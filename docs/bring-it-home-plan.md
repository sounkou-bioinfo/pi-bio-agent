---
type: Proposal
title: Bring-it-home plan — core substrate closure
description: "Core-library closure ledger after the workbench split: what is closed in pi-bio-agent, what proves it, and what remains outside core."
tags: [roadmap, substrate, host-events, jobs, graph-projection, artifacts, corpus, ducknng]
---

# Bring-it-home plan — core substrate closure

This is the core-library closure ledger after splitting application work into a downstream workbench. It is not an
application roadmap. Core owns primitives, validators, receipts, replay, CAS, graph/observation storage, and
host-injected effect ports. Applications own manifests, operation packs, report formats, review rubrics, UI, and
domain pipelines.

The test for "home" is simple: an application path should be expressible as declared resources -> SQL/materialization
-> async compute when needed -> recorded run -> observations/links -> CAS artifacts -> replay/export. If a downstream
app cannot do that without bypassing the ledger, that is a core gap. If it can, the behavior belongs downstream.

## Why It Matters

OpenAI's June 18, 2026 rare-disease reanalysis report is a useful forcing function: previously unsolved cases became
interpretable as gene-disease relationships, variant evidence, literature, and tools changed. The generic lesson is
not rare-disease specific. Scientific value sits in evolving ecosystems of packages, data formats, ontologies,
knowledge graphs, statistical methods, and papers. The library's job is to make that practice accessible as declared,
replayable, queryable workflows with receipts, CAS artifacts, environment evidence, and recorded judgments.

## Closed In Core

These items are no longer open substrate work in `pi-bio-agent`.

- **Session traces are observation projections.** Persisted Pi JSONL is stored in CAS and projected into
  `session:`, `entry:`, `msg:`, `turn:`, `toolcall:`, and `cas:` facts/edges in `bio_observations`. There are no
  `session_*` base tables. Evidence: [session-ingest.ts](../src/hosts/session-ingest.ts),
  [session-ingest.test.ts](../test/session-ingest.test.ts), [pi-extension.test.ts](../test/pi-extension.test.ts).
- **Chat-to-run stitching is a generic edge.** Controlled tool execution records `toolcall:<id> executes run:<id>`
  and `run:<id> invoked_by toolcall:<id>` through `recordObservationLink`. Transcript scanning is not part of the
  design. Evidence: [pi-extension.test.ts](../test/pi-extension.test.ts),
  [training-corpus.test.ts](../test/training-corpus.test.ts).
- **Runs, memory, jobs, facts, traces, and artifacts share one ledger.** They are rows in `bio_observations`, read
  as-of and projected to `bio_edges_as_of`. Evidence: [observations.ts](../src/duckdb/observations.ts),
  [memory-and-knowledge-unification.md](memory-and-knowledge-unification.md), [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **Async execution has one lifecycle.** `AsyncRunner` is `submit/status/collect/cancel`. `ComputeRunner` and
  `JobRunner` specialize that shape; `in-memory-job-runner`, `ledger-job-runner`, and `queue-job-runner` are
  implementations. Resume is checkpoint-based, not a workflow engine. Evidence: [jobs.ts](../src/core/jobs.ts),
  [job-store.ts](../src/hosts/job-store.ts), [job-runner.test.ts](../test/job-runner.test.ts),
  [job-step-plan.test.ts](../test/job-step-plan.test.ts), [ledger-job-runner.test.ts](../test/ledger-job-runner.test.ts),
  [python-workflow-dogfood.test.ts](../test/python-workflow-dogfood.test.ts),
  [absurd-queue-push-dogfood.test.ts](../test/absurd-queue-push-dogfood.test.ts).
- **Host-event receipts are open host facts.** `recordHostEvent` records one `host_event` fact plus optional ordinary
  links stamped with the host-event statement/observation id. `kind` is host-owned data, not a core enum. The
  training corpus exports both digest-only event rows and redacted event-link rows. Evidence:
  [host-events.ts](../src/hosts/host-events.ts), [host-events.test.ts](../test/host-events.test.ts),
  [training-corpus.ts](../src/hosts/training-corpus.ts).
- **Compute environments are declared and observed as receipts.** `compute.run` can record declared-vs-observed
  `EnvDescriptor` evidence; `withObservedEnvironment` attaches host-known runtime/package state to any runner.
  Evidence: [compute-run.ts](../src/duckdb/resolvers/compute-run.ts),
  [compute-env-attestation.test.ts](../test/compute-env-attestation.test.ts), [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **CAS rooting has the shared-safe path.** Run result/receipt/replay/run-object bytes are registered as `cas_object`
  and rooted by `cas_ref` when `casMetadata` is supplied on the same SQL authority as the run ledger. Shared GC uses
  ref/lease anti-joins instead of local receipt scraping. Evidence: [cas-metadata.ts](../src/hosts/cas-metadata.ts),
  [gc.ts](../src/hosts/gc.ts), [run-observations.test.ts](../test/run-observations.test.ts),
  [cas-metadata-gc.test.ts](../test/cas-metadata-gc.test.ts).
- **Figures and reports are CAS-addressed artifacts.** `recordArtifactReference` records intrinsic byte metadata on
  `cas:<digest>` plus an ordinary graph reference from the producing/displaying node. Media type, semantic role,
  plotting system, source digest, and spec digest ride as artifact/reference metadata; declared compute outputs can
  also carry open `mediaType`, `semanticRole`, and `attrs` metadata into receipts and files-only artifact tables.
  CAS-backed successful runs with a store now fold those declared outputs into the same artifact fact/edge path, so
  reports and figures produced by R/Python/bash compute are graph-walkable and corpus-visible. When the host also
  supplies shared `casMetadata`, run-produced artifacts are rooted by run-scoped artifact refs. There is no separate
  plot table. Session-ingest image blocks and training-corpus export use the same path. Evidence:
  [artifacts.ts](../src/hosts/artifacts.ts), [artifact-observations.test.ts](../test/artifact-observations.test.ts),
  [run-observations.test.ts](../test/run-observations.test.ts),
  [session-ingest.test.ts](../test/session-ingest.test.ts), [training-corpus.test.ts](../test/training-corpus.test.ts),
  [compute-artifacts-example.test.ts](../test/compute-artifacts-example.test.ts),
  [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **Foreign graph projection has a real external source.** `GraphProjectionProfile` projects staged source tables
  into SemanticSQL edge columns; Monarch KGX over HTTP exercises the first real external KG path. Evidence:
  [graph-projection.ts](../src/core/graph-projection.ts), [graph-projection.test.ts](../test/graph-projection.test.ts),
  [monarch-kg-http-example.test.ts](../test/monarch-kg-http-example.test.ts).
- **SemanticSQL source-spec compatibility is closed at the substrate level.** `materializeSemanticSqlSourceViews`
  turns staged `statements`, optional `prefix`, optional upstream `entailed_edge`, optional `term_association`, and
  optional `textual_transformation` tables into the generated inspection views that graph projection and manifests
  consume: edge, labels, definitions, synonyms, mappings, RDF list/member, node/identifier/count, OWL
  node/property/axiom/restriction, OBO problem, RO/ChEBI filters, metadata, superproperty expansion, match, term, and
  taxon-constraint views. Evidence: [semantic-sql.ts](../src/duckdb/semantic-sql.ts),
  [graph-projection.test.ts](../test/graph-projection.test.ts), [design.md](design.md#the-semanticsql-shape-source-spec---local-graph-tables).
- **Training corpus export is a derived projection.** The core exports digest-only session/tool/run/artifact/event
  tables, host-event link rows, and Parquet receipts from the ledger under the `pi-bio.training_corpus.v3` receipt
  contract. Redaction policy and labels are
  application-owned. Evidence:
  [training-corpus.ts](../src/hosts/training-corpus.ts), [training-corpus.test.ts](../test/training-corpus.test.ts).
- **SDK surface is externally checked.** Root, `/core`, `/duckdb`, and `/hosts` exports cover the host-facing types
  and helpers used by a packed downstream consumer; a runnable host-embedding dogfood imports from `pi-bio-agent`
  and composes `SqlConn`, `CasStore`, `ComputeRunner`, SQL policy, host capability receipts, and CAS metadata over a
  real run. Evidence: [package.json](../package.json), [guide.md](guide.md),
  [sdk-host-embedding.mjs](../scripts/sdk-host-embedding.mjs),
  [sdk-host-embedding.test.ts](../test/sdk-host-embedding.test.ts),
  [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **ducknng profile receipts and admission are pinned without secrets.** Profile receipts carry redacted
  scope/version/subject digests; host capability receipt digests affect replay/provenance/action-cache keys. Caller
  SQL cannot override a host-owned profile auth header. The sibling `ducknng` HTTP profile tests cover credential
  rotation, header-collision rejection, subject allowlists, scoped profile listing, service request subject
  bracketing, and streaming-query session subject bracketing. Adjacent ducknng transport tests cover mTLS peer
  identity and exact peer allowlists. Core receipt evidence plus sibling conformance evidence:
  [http-profiles.ts](../src/duckdb/http-profiles.ts),
  [ducknng-http-profiles.test.ts](../test/ducknng-http-profiles.test.ts),
  [ducknng-sql-http.test.ts](../test/ducknng-sql-http.test.ts),
  [ducknng HTTP profile tests](https://github.com/sounkou-bioinfo/ducknng/blob/395ed5c/test/sql/ducknng_http_profiles.test),
  [ducknng mTLS tests](https://github.com/sounkou-bioinfo/ducknng/blob/395ed5c/test/sql/ducknng_mtls_auth.test),
  [ducknng peer-allowlist tests](https://github.com/sounkou-bioinfo/ducknng/blob/395ed5c/test/sql/ducknng_peer_allowlist.test).
- **Remote HTTP/CAS reuse is scoped consistently.** `remoteCacheScope` is the host-owned isolation key for shared
  remote freshness and CAS reuse. It now threads through direct resolver use, `runQuery` / `runOperation`, packaged
  `runBioQueryFromManifest` / `runBioOperationFromManifest`, reproduce, the CLI host flag, and the Pi extension host
  option. Absence still skips cross-db remote reuse. Evidence: [operations.ts](../src/core/operations.ts),
  [run-store.ts](../src/hosts/run-store.ts), [reproduce.ts](../src/hosts/reproduce.ts),
  [host-run-operation.test.ts](../test/host-run-operation.test.ts).
- **The packaged substrate skill is an integration point, not a computation pack.** Host presets install the
  procedural skill for Codex, Pi, Claude, OpenCode, and GitHub Copilot; the package exposes `./skills`; and the
  dogfood runs catalog -> manifest query/run -> ledger fact -> graph-window paging through the CLI. Evidence:
  [install-skill.mjs](../scripts/install-skill.mjs), [substrate-skill-dogfood.mjs](../scripts/substrate-skill-dogfood.mjs),
  [skill-validation.test.ts](../test/skill-validation.test.ts), [project-host.test.ts](../test/project-host.test.ts).

The compact proof is:

```sh
npm run dogfood:bring-it-home
npm run dogfood:sdk-host-embedding
```

Together these commands exercise host-event receipts, step checkpoints/resume, graph projection, ducknng profile
receipts, public SDK imports, training-corpus Parquet export/readback, session tool-call/run stitching, CAS metadata
roots, host policy hooks, and real process compute when R is available.

## Pending Issue Ledger

This section closes over the deferred/not-deferred backlog. Items listed here are current-state issues, not old chat
residue. If an item from an earlier list is not in "active", it has been reclassified below as closed,
consumer-pulled, or a non-goal.

### Active / Not Deferred

1. **Docs hygiene.** Keep README and guides action-first: real commands, real code chunks, no fake text-block
   architecture diagrams, and no speculative filesystem-extension claims. Claims should point to commands, tests, or
   examples that currently run.

### Consumer-Pulled / Deferred

1. **Runtime interrupt/abort host adapters.** The current Pi extension surface records session lifecycle, input
   delivery, and before-provider context receipts. It should record interrupt/abort receipts only when a host exposes
   a stable runtime event or when a consumer reads that event. Do not infer interrupts from missing transcript text or
   from a generic `AbortSignal` without a host-owned event contract.
2. **Scheduler-native durable backends.** The async lifecycle, durable queue, cancellation, checkpoint resume, local
   process runner, ducknng RPC worker dogfood, and Python checkpointed workflow path exist. A scheduler-specific
   backend should be added only when a real SLURM/targets/mirai/nanonext-style consumer needs adapter semantics
   beyond the current `JobRunner` / checkpoint shape. This is not a request for another workflow engine.
3. **Scoped relation/resource visibility.** Only build this when a host needs visibility narrower than its injected
   `SqlConn`. The current pattern is a host-owned connection wrapper: hidden relations should fail for `SELECT`,
   `DESCRIBE`, `SUMMARIZE`, and catalog/introspection reads on that connection. For remote services, this belongs in
   host/ducknng admission and receipts, not SQL string guards.
4. **SemanticSQL policy and ingest adapters.** The source-spec view/projection layer is closed for core. Remaining
   work is consumer-pulled: relation-graph equivalence/reflexivity/individual reasoning policy, source-specific
   trust weighting/reconciliation, and thin ontology-ingest resolvers that stage real source artifacts with receipts.
5. **Training corpus hardening.** Redaction policy, label schema, export contract, and VARIANT-shredded Parquet are
   required once a real corpus consumer exists. The base ledger remains `value_json`; typed Parquet is a derived
   export.
6. **Renderer/report product metadata.** Core has CAS-addressed figure/report artifacts, declared-output metadata,
   automatic compute-output artifact observations, and host-conditional shared-CAS artifact refs for real
   R/Python/bash-produced reports and figures. Richer renderer-specific schemas, review-packet structure, and UI
   report models wait for downstream applications that need them.
7. **SDK maintenance.** Required exports should follow real sibling consumers. Each new public type/helper needs a
   packed external-consumer dogfood so the library remains usable outside this repo.
8. **Workbench package abstractions.** `pi-bio-workbench` should remain a downstream app. Core closes over primitives
   only after that app proves repeated shape; clinical genomics is the first binding, not a reason to prebuild a
   framework.
9. **External tool robustness tests.** `rv`, OpenTargets, Monarch DuckDB, ChEMBL, R `targets`/`mirai`/`nanonext`,
   and similar systems should first enter through manifests, SQL, `compute.run`, and receipts. Add primitives only
   when that route fails for a concrete reason.
10. **Entity identity normalization.** BioBTree-style KGX exports make this the strongest graph-adjacent candidate:
   node category, label, equivalent identifiers, source ids, and node attributes are not edge projection. Keep it
   downstream until Monarch/OpenTargets/BioBTree-like consumers force the same normalized node view.
11. **ducknng-fs / DuckTinyCC research.** A filesystem-shaped or C-FFI-shaped lane is interesting only when a real
   manifest needs it. It is not a current core primitive.

### Closed / Reclassified From Earlier Backlog

- **ducknng subject/auth/profile rotation at the core receipt layer.** `refreshDucknngHttpProfile`, redacted profile
  receipts, subject-restriction digests, and action/replay key pinning exist. Remaining work is product conformance
  and host adapter work, not another core auth primitive.
- **Base durable runner/resume.** `AsyncRunner` is the lifecycle; `JobRunner` and checkpoint helpers specialize it.
  Resume means completed-prefix checkpoint reuse plus suffix rerun. The bring-it-home dogfood covers checkpointed
  bash steps, queue cancellation, lease reclaim, stale-attempt rejection, and redacted scheduler host events; focused
  tests cover a ducknng RPC worker and a real Python checkpointed workflow. Evidence: [job-store.ts](../src/hosts/job-store.ts),
  [ledger-job-runner.test.ts](../test/ledger-job-runner.test.ts),
  [python-workflow-dogfood.test.ts](../test/python-workflow-dogfood.test.ts),
  [bring-it-home-dogfood.mjs](../scripts/bring-it-home-dogfood.mjs), [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **ducknng/quack sibling upload and shared-data path.** Upload-shaped movement stays in the sibling transport, not
  in core. The non-skipped dogfood command loads an upload-capable sibling `ducknng.duckdb_extension`, streams local
  SQL rows into a remote DuckDB table through `ducknng_upload_table`, rejects a type-mismatched partial append, and
  records the committed upload as a host event plus ordinary graph links. Evidence:
  [ducknng-upload-shared-data.test.ts](../test/ducknng-upload-shared-data.test.ts),
  [ducknng-upload-dogfood.mjs](../scripts/ducknng-upload-dogfood.mjs). Run with
  `npm run dogfood:ducknng-upload` after building sibling `ducknng`, or set `DUCKNNG_EXTENSION_PATH`.
- **`recordHostEvent` primitive.** Built as one open host event fact plus ordinary links. The bring-it-home dogfood
  records workbench-style input events, scheduler-style queue events, and host-owned governance submitted/decided
  events around the durable approval gate without a closed event model. The Pi extension records session lifecycle
  receipts, `before_agent_start` context receipts, and input delivery receipts as digests/counts only. The corpus
  projection exposes lifecycle type/reason/parentage, input source/streaming behavior/text digest, and event-link
  targets without raw payloads or raw link attrs.
- **Foreign graph projection base.** A real external Monarch KGX HTTP path, internal observation-graph projection,
  and generated SemanticSQL `statements` -> `edge` view path exist. Remaining foreign-graph work is consumer
  conformance and adapter pressure, not a new graph primitive.
- **SemanticSQL source-spec base parity.** The generated source-spec view layer, prefix canonicalization, upstream
  closure artifact path, term-association projection, metadata packaging, superproperty expansion, multi-schema
  staging, and graph projection path exist. Remaining relation-graph policy and trust reconciliation are
  consumer-pulled.
- **Base graphics/report artifact evidence.** Figures, reports, compute-produced file outputs, and session images
  are CAS artifacts linked through `bio_observations`/`bio_edges_as_of`; run-produced output roots are registered
  under shared CAS metadata when the host supplies that authority. Renderer-specific report models remain downstream.
- **Base training-corpus export.** Digest-only ledger/session/tool/run/artifact/event exports and redacted
  host-event-link exports exist. Labels and redaction remain consumer-pulled.
- **Base SDK packaging.** Root, `/core`, `/duckdb`, and `/hosts` exports are checked by a packed downstream
  embedding dogfood. Expansion remains consumer-driven.
- **Substrate skill and non-Pi host dogfood.** The skill is a host-neutral onboarding/playbook surface for agents
  that do not run the Pi extension. It points them at catalog, manifest inspection, read-only SQL, ledger/graph
  windowing, and thin playbook graduation. The installer covers Codex, Pi global/project, Claude, OpenCode, GitHub
  Copilot, and generic destination roots; validation rejects executable clients, secrets, and patient identifiers.
- **Lazy resource forcing.** Ad-hoc `bio_query` no longer resolves every manifest resource by default. When
  `resources` is omitted, the host infers the minimal resource set from DuckDB parser-discovered table references
  and manifest `params.table` values; catalog-style schema discovery can still force the inspected table. Ambiguous
  table-to-resource mappings fail clearly. Evidence: [resource-forcing.ts](../src/core/resource-forcing.ts),
  [run-store.ts](../src/hosts/run-store.ts), [host-run-operation.test.ts](../test/host-run-operation.test.ts).
- **Host capability CLI profile commissioning.** `pi-bio-agent query` / `run` accept
  `--ducknng-http-profile <json>` as a host-owned runtime adapter. The profile JSON names only non-secret policy and
  a credential source (`authHeaderValueEnv` or `authHeaderValueStdin`); the run registers the ducknng HTTP profile
  on the same DuckDB connection before resources resolve, then pins only the redacted receipt digest in
  replay/provenance. Evidence: [run.ts](../src/cli/run.ts), [run-store.ts](../src/hosts/run-store.ts),
  [cli-run.test.ts](../test/cli-run.test.ts).

### Non-Goals In Core

- New biomedical helpers for individual questions.
- Per-question skill packs. Skills are onboarding/playbook integration points; stable scientific work belongs in
  manifests, SQL, operations, compute specs, receipts, and observations.
- A closed topology taxonomy or special `topology:` node kind in core. Multi-agent, fork/resume, and workflow
  correlation are expressed with caller-owned `workflow:`, `session:`, `step:`, or similar nodes plus ordinary edges.
- A closed runtime event enum such as `pi.input.steer` / `pi.interrupt`. Event `kind` strings are host-owned data.
- Regex transcript/run-id harvesting. Use self-declaring tool/run/session links and ledger observations.
- Secrets or capability policy in manifests, SQL strings, command-line argv, or agent-authored config. Hosts grant
  effects and provide secret-free receipts.
- Special hiding rules for `DESCRIBE` or `SUMMARIZE`; they are ordinary DuckDB inspection over relations the host made
  visible.
- Process-first operation syntax as a separate primitive. `compute.run` already provides process/argv execution,
  declared file artifacts, streamed CAS capture, environment evidence, async runner integration, receipts, and
  replay. If a downstream app proves the authoring shape is awkward, add only a thin facade over those pieces.
- Another workflow engine above step checkpoints and the async runner lifecycle.

## Verification

Use the normal gate plus focused dogfood:

```sh
npm run typecheck
npm test
npm run check:docs
npm run check:examples
npm run check:readme-tools
npm run dogfood:bring-it-home
npm run dogfood:ducknng-upload  # requires an upload-capable sibling ducknng build or DUCKNNG_EXTENSION_PATH
npm run dogfood:sdk-host-embedding
```

For review, use a persistent Pi review session as described in [AGENTS.md](../AGENTS.md). The review should ask from
both consumer and maintainer perspectives whether a change adds a real primitive, closes an existing gap, or belongs in
a downstream app or sibling `ducknng`.
