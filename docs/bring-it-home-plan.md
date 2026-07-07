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
  [job-step-plan.test.ts](../test/job-step-plan.test.ts), [absurd-queue-push-dogfood.test.ts](../test/absurd-queue-push-dogfood.test.ts).
- **Host-event receipts are open host facts.** `recordHostEvent` records one `host_event` fact plus optional ordinary
  links. `kind` is host-owned data, not a core enum. Evidence: [host-events.ts](../src/hosts/host-events.ts),
  [host-events.test.ts](../test/host-events.test.ts), [training-corpus.ts](../src/hosts/training-corpus.ts).
- **Compute environments are declared and observed as receipts.** `compute.run` can record declared-vs-observed
  `EnvDescriptor` evidence; `withObservedEnvironment` attaches host-known runtime/package state to any runner.
  Evidence: [compute-run.ts](../src/duckdb/resolvers/compute-run.ts),
  [compute-env-attestation.test.ts](../test/compute-env-attestation.test.ts), [bring-it-home-dogfood.test.ts](../test/bring-it-home-dogfood.test.ts).
- **CAS rooting has the shared-safe path.** Run result/receipt/replay/run-object bytes are registered as `cas_object`
  and rooted by `cas_ref` when `casMetadata` is supplied on the same SQL authority as the run ledger. Shared GC uses
  ref/lease anti-joins instead of local receipt scraping. Evidence: [cas-metadata.ts](../src/hosts/cas-metadata.ts),
  [gc.ts](../src/hosts/gc.ts), [run-observations.test.ts](../test/run-observations.test.ts),
  [cas-metadata-gc.test.ts](../test/cas-metadata-gc.test.ts).
- **Foreign graph projection has a real external source.** `GraphProjectionProfile` projects staged source tables
  into SemanticSQL edge columns; Monarch KGX over HTTP exercises the first real external KG path. Evidence:
  [graph-projection.ts](../src/core/graph-projection.ts), [graph-projection.test.ts](../test/graph-projection.test.ts),
  [monarch-kg-http-example.test.ts](../test/monarch-kg-http-example.test.ts).
- **Training corpus export is a derived projection.** The core exports digest-only session/tool/run/artifact/event
  tables and Parquet receipts from the ledger. Redaction policy and labels are application-owned. Evidence:
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

The compact proof is:

```sh
npm run dogfood:bring-it-home
npm run dogfood:sdk-host-embedding
```

Together these commands exercise host-event receipts, step checkpoints/resume, graph projection, ducknng profile
receipts, public SDK imports, training-corpus Parquet export/readback, session tool-call/run stitching, CAS metadata
roots, host policy hooks, and real process compute when R is available.

## Remaining Work

These are the remaining lanes. Several are required to bring the substrate home; the constraint is that they should
close over existing primitives and concrete consumers, not become speculative taxonomies.

1. **Lazy resource forcing.** Resolve only the declared resources a query or operation actually names, while keeping
   the manifest contract explicit and fail-closed. This is required for larger manifests and agent-authored
   manifests, not a new resource model.
2. **ducknng/quack sibling upload and shared-data path.** Use the sibling transport that fits the operation:
   ducknng RPC is the proven mutable-state path; append/share or upload-shaped paths may use quack where that fits.
   Keep this in the sibling transport/host layer and surface it to core through receipts, `SqlConn`, CAS, and
   resolver handles.
3. **Scoped relation/resource visibility.** The current pattern is
   a host-owned `SqlConn` wrapper: a host that hides a relation should deny `SELECT`, `DESCRIBE`, `SUMMARIZE`, and
   catalog/introspection reads on that injected connection. `ducknng` HTTP profile admission is the corresponding
   network/profile gate. Do not add ad-hoc SQL string guards here. If a real embedding host needs centrally managed,
   subject-scoped relation or resource visibility across remote services, implement it as a host/ducknng admission
   feature and receipt it.
4. **Training corpus hardening.** This is required, not optional: redaction policy, label schema, export contract,
   and VARIANT-shredded Parquet for nested session/tool/run payloads. The base ledger remains `value_json`; typed
   Parquet is a derived export for downstream corpus consumers.
5. **Graphics/report metadata from real reports.** Core has `recordArtifactReference`; richer renderer metadata is
   required once R/Python/HTML report paths emit it. Add fields from real artifacts and report consumers, not from a
   guessed plot-table schema.
6. **SDK maintenance.** Required exports should follow real sibling consumers. Each new public type/helper needs a
   packed external-consumer dogfood so the library boundary stays usable from outside the repo.
7. **Host adapters over `recordHostEvent`.** `recordHostEvent` is available; concrete Pi/workbench/scheduler hook
   adapters are required where control events affect training, replay, steering, interruption, or governance. They
   should record only events the host actually emits and only the receipts a consumer reads.

## Non-Goals In Core

- New biomedical helpers for individual questions.
- A closed topology taxonomy or special `topology:` node kind in core. Multi-agent, fork/resume, and workflow
  correlation are required, but they are expressed with caller-owned `workflow:`, `session:`, `step:`, or similar
  nodes plus ordinary edges.
- Special hiding rules for `DESCRIBE` or `SUMMARIZE`; they are ordinary DuckDB inspection over relations the host made
  visible.
- Process-first operation syntax as a separate primitive. `compute.run` already provides process/argv execution,
  declared file artifacts, CAS capture, environment evidence, async runner integration, receipts, and replay. If a
  downstream app proves that wrapping process work as a `compute.run` resource is repeatedly awkward, add only a thin
  authoring facade over those existing pieces.
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
npm run dogfood:sdk-host-embedding
```

For review, use a persistent Pi review session as described in [AGENTS.md](../AGENTS.md). The review should ask from
both consumer and maintainer perspectives whether a change adds a real primitive, closes an existing gap, or belongs in
a downstream app or sibling `ducknng`.
