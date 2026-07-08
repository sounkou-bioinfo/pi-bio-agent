---
type: Worklog
title: Refinements
description: "Live cleanup targets that still need concrete consumer pressure before they become core work."
tags: [refinements, open-issues, worklog]
---

# Refinements

This is the live refinement ledger. It is intentionally short. Stable decisions live in
[`design.md`](./design.md), current closure status lives in
[`bring-it-home-plan.md`](./bring-it-home-plan.md), and practical usage lives in
[`guide.md`](./guide.md) plus the examples. Historical notes should stay in git history, not in the reader's way.

## Rules For New Work

- Start from a concrete manifest, operation, resolver, test, or downstream app need.
- Prefer data, SQL, graph projection, receipts, CAS, and host-injected ports over new TypeScript surfaces.
- Do not add per-question biomedical helpers to core. A new question should become a manifest, SQL, a term set, an
  operation spec, or a downstream adapter.
- If an effect touches network, filesystem, credentials, process execution, or tenant visibility, the host grants
  that capability. Core records contracts and evidence; it is not the sandbox.
- When a refinement is resolved, move the stable rule to the owning doc and delete the scratch item here.

## Active Core Cleanup

### Docs Hygiene

Keep public docs action-first:

- Commands should run.
- README examples should come from `README.Rmd`, not direct edits to `README.md`.
- Prefer `sh`, `sql`, `json`, `ts`, or real rendered output blocks over prose-only diagrams.
- Avoid speculative extension claims. If a filesystem, graph, scheduler, renderer, or API claim is not exercised by
  a command, test, or example, keep it as consumer-pulled.
- Claims should point to evidence: a file, command, test, example, or generated README block.

This is the only currently active bring-it-home core item. Everything below needs a consumer before it becomes core
implementation work.

## Consumer-Pulled Refinements

### Runtime Interrupt Receipts

`recordHostEvent` is built as one open host-event fact plus ordinary links. The Pi extension records lifecycle,
input delivery, and before-agent-start context receipts. Bring-it-home dogfood records scheduler and governance
events and proves redacted host-event links reach the training corpus.

Do not infer interrupts from missing transcript text or from a generic `AbortSignal`. Add interrupt/abort receipts
only when a host exposes a stable runtime event or a corpus/workbench consumer reads it.

Evidence: `src/hosts/host-events.ts`, `test/host-events.test.ts`,
`test/training-corpus.test.ts`, `extensions/pi-coding-agent/index.ts`.

### Scheduler-Native Backends

The base lifecycle is closed: `submit`, `status`, `collect`, `cancel`, durable queue rows, terminal ledger facts,
and step checkpoints. Resume means completed-prefix checkpoint reuse plus suffix rerun.

Add a scheduler-specific backend only when a real SLURM, `targets`, `mirai`, `nanonext`, NNG worker, or workbench
consumer needs adapter behavior beyond the current `JobRunner` and checkpoint shape. Do not add another workflow
engine.

Evidence: `src/core/jobs.ts`, `src/hosts/job-store.ts`, `src/hosts/job-queue.ts`,
`test/queue-job-runner.test.ts`, `test/python-workflow-dogfood.test.ts`,
`scripts/nng-job-runner.mjs`.

### Scoped Relation Visibility

Build only if a host needs table/resource visibility narrower than its injected `SqlConn`. The expected shape is a
host-owned connection wrapper or ducknng admission policy where hidden relations fail for `SELECT`, `DESCRIBE`,
`SUMMARIZE`, and catalog/introspection reads. Do not implement this as SQL string guards.

### SemanticSQL Policy And Ingest Adapters

Source-spec base parity is closed: staged `statements`, optional `prefix`, upstream `entailed_edge`,
`term_association`, and `textual_transformation` can generate inspection views and project through the same graph
profile path as KGX, memory, and observations.

Remaining work is policy or ingestion:

- relation-graph equivalence/reflexivity/individual reasoning policy,
- source-specific trust weighting/reconciliation,
- a thin ontology-ingest resolver that stages real artifacts with receipts when a consumer needs it,
- node identity normalization for BioBTree-style exports when multiple graph consumers force one shared node view.

Evidence: `src/duckdb/semantic-sql.ts`, `src/duckdb/graph-projection.ts`,
`test/graph-projection.test.ts`, `examples/monarch-kg-http/`.

### Training Corpus Hardening

The base corpus export is digest-first and redacted: sessions, tool calls, runs, artifacts, host events,
host-event links, and judgments. Add labels, redaction policy, export contracts, or VARIANT-shredded Parquet only
when a real corpus consumer specifies the needed shape.

Evidence: `src/hosts/training-corpus.ts`, `test/training-corpus.test.ts`.

### Renderer And Report Metadata

Core already records reports, figures, session images, and compute-produced file outputs as CAS artifacts with
graph-visible observations. Rich review packets, renderer-specific schemas, notebook models, and UI report objects
belong downstream until a workbench or report consumer repeats the shape.

Evidence: `src/hosts/artifact-observations.ts`, `test/artifact-observations.test.ts`,
`test/run-observations.test.ts`, `scripts/bring-it-home-dogfood.mjs`.

### SDK Surface

Exports should follow real sibling consumers. Add a public helper or type only with an external packed-consumer
dogfood proving that a host can import and use it without reaching into internals.

Evidence: `scripts/sdk-host-embedding.mjs`, `test/cli-run.test.ts`, package `exports`.

### External Tool Robustness

Try new systems through the substrate first:

- `rv`,
- OpenTargets,
- Monarch DuckDB,
- ChEMBL,
- R `targets`,
- `mirai` / `nanonext`,
- Nextflow or other process tools.

The first attempt should be manifest + SQL, `compute.run`, graph projection, or host-injected runner/receipts. Add
a primitive only when that route fails for a concrete reason.

### ducknng-fs / DuckTinyCC Research

A filesystem-shaped lane or C-FFI lane remains research. It becomes core only if a real manifest needs it and the
need cannot be expressed as DuckDB table functions, SQL materialization, `compute.run`, or a host adapter.

## Lower-Priority Technical Refinements

These are known sharp edges, not current implementation requests.

### Clock And Identity Determinism

- `systemClock()` centralizes wall-clock reads. A stricter mode could require `now` at every host entrypoint, but
  that touches many test call sites and should wait for a reproducible-run consumer.
- Generated run ids and note ids are intentionally host effects. Inject an `idFactory` or require explicit ids only
  where reproducible identity matters.

### Resolver Cache Controls

The resolution memo changes performance, not result identity, when freshness receipts match. Add a cold-run
`cache: false` option only when a caller needs to force re-resolution for audit or benchmark work.

### HTTP Receipt Detail

`http.get` supports cancellation, capped body reads in the networked adapter, retry policy, ETag/Last-Modified
revalidation, and CAS reuse under a host-provided scope. Optional receipt additions:

- `revalidatedAt` for `304` checks,
- final redirected URL when the fetch port exposes it,
- per-call acknowledgement only as an extra UI/transcript signal, never as the hard network grant.

### Compute Environment Snapshot

`compute.run.params.env` is non-secret manifest data. Host secrets must come through the host-injected runner, not
manifest env. A future redaction mode could persist env keys while omitting values, but that trades replay fidelity
for secret safety and needs an application requirement.

### Retrieval Ladder

Grounding stays deterministic-first:

1. exact SQL over labels/synonyms,
2. DuckDB FTS/BM25 when a real miss requires lexical recall,
3. DuckDB VSS only if the corpus forces paraphrase recall,
4. external late-interaction retrieval only as a resolver/service returning ranked candidates.

The model receives candidates and produces typed judgment; it is not the fact store.

### Shared CAS Integration Niceties

Shared CAS metadata, refs, leases, and GC are built. Remaining integration niceties are consumer-driven:

- lease around cross-db CAS reuse in resolvers,
- `gc_epoch` or tombstone event rows for cross-node observers,
- ducknng-served metadata-authority dogfood if a shared deployment needs it,
- local LRU touch on hit for node-local cache ergonomics.

## Resolved Elsewhere

Do not reopen these here without new evidence:

- provider-agnostic manifest/query/run path,
- read-only SQL guard plus plan-hermeticity checks,
- lazy resource forcing,
- host-injected network and compute ports,
- `duckdb.sql_materialize` as the general materialization primitive,
- `duckhts.read_bcf` range reads for indexed VCF/BCF,
- CAS byte store and shared CAS metadata GC,
- action-cache/replay/reproduce contracts,
- `recordHostEvent` base primitive and redacted corpus export,
- durable job queue, cancellation, and checkpoint resume,
- graph projection profiles and SemanticSQL source-spec base parity,
- packaged host-neutral skill and installer presets,
- SDK base exports checked by packed-consumer dogfood.

The evidence for those items is in `bring-it-home-plan.md`, `design.md`, the examples, and the focused tests.
