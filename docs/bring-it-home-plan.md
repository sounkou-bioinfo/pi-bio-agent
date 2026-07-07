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
- **ducknng profile receipts are pinned without secrets.** Profile receipts carry redacted scope/version/subject
  digests; host capability receipt digests affect replay/provenance/action-cache keys. Caller SQL cannot override a
  host-owned profile auth header. Evidence: [http-profiles.ts](../src/duckdb/http-profiles.ts),
  [ducknng-http-profiles.test.ts](../test/ducknng-http-profiles.test.ts), [ducknng-sql-http.test.ts](../test/ducknng-sql-http.test.ts).

The compact proof is:

```sh
npm run dogfood:bring-it-home
npm run dogfood:sdk-host-embedding
```

Together these commands exercise host-event receipts, step checkpoints/resume, graph projection, ducknng profile
receipts, public SDK imports, training-corpus Parquet export/readback, session tool-call/run stitching, CAS metadata
roots, host policy hooks, and real process compute when R is available.

## Remaining Work

These are the remaining lanes. They should not become new core abstractions until an application proves a gap.

1. **ducknng subject/auth depth.** Finish the sibling `ducknng` runtime and adapter work: host-only subject bracketing
   for non-service embedding hosts, profile rotation ergonomics, TLS/mTLS fixture breadth, and possibly scoped
   relation/resource visibility. Keep this in ducknng plus secret-free receipts, not SQL string guards.
2. **Training corpus hardening.** App-driven redaction policy, label schema, export contract, and VARIANT-shredded
   Parquet when a real downstream corpus consumer benefits from nested typed columns. The base ledger remains
   `value_json`.
3. **Graphics/report metadata from real reports.** Core has `recordArtifactReference`; richer renderer metadata should
   be added only when a downstream R/Python/HTML report path emits it.
4. **Process operation transport.** Still real, still deferred. Meaning: a declared operation whose executor is a
   process/argv/run-dir, reusing `ComputeRunner`, checkpoints, CAS output capture, and replay specs. Build it only
   when a real workflow step needs operation semantics rather than `compute.run` as a table resolver.
5. **SDK maintenance.** Add public exports only when a sibling app needs a stable type, and prove each export through
   the packed external-consumer dogfood.
6. **Host adapters.** `recordHostEvent` is available. Concrete Pi/workbench/scheduler hook adapters should record only
   events the host actually emits, and only when a consumer reads those receipts.

## Non-Goals In Core

- New biomedical helpers for individual questions.
- Topology primitives for swarms, forks, or resumes. Use caller-owned nodes plus ordinary edges.
- Special hiding rules for `DESCRIBE` or `SUMMARIZE`; they are ordinary DuckDB inspection over relations the host made
  visible.
- Process transport before a real workflow needs it.
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
