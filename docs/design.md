---
type: Reference
title: Conceptual architecture
description: "The canonical conceptual model for core boundaries, execution, evidence, memory, and host composition."
tags: [architecture, contracts, execution, evidence, memory]
---

# Conceptual architecture

This is the conceptual checksum for `pi-bio-agent`. It defines the small set of ideas that shared code must preserve.
Focused mechanics belong in the linked reference documents; historical influences belong in
[lineage.md](lineage.md).

## The bet

`pi-bio-agent` replaces per-question skill sprawl with programs over declared scientific data. A new question should
usually require schema inspection and SQL, not a new TypeScript helper or skill.

```text
declared resources
  -> schema discovery
  -> agent-authored SQL or declared operation
  -> execution through host-granted capabilities
  -> result + receipts + replay + CAS
  -> temporal observations and graph projections
  -> typed judgment or approval where evidence cannot decide
```

The actor may be a human, model, service, or group of agents. The substrate does not assign facts according to the
actor's cognitive status. It provides queryable data, bounded effects, durable evidence, and explicit judgment points.
Tasks that share this execution shape should reuse it; variation belongs in manifests, relations, SQL, and compute
parameters rather than new tool protocols.

## Invariants

1. **The model is not a biomedical fact source.** Facts come from declared data, deterministic computation, receipts,
   or recorded approval. An actor may inspect, compose, explain, propose, and abstain.
2. **Manifests and SQL are the program.** TypeScript interprets declarations and binds host capabilities. It does not
   accumulate question-specific biomedical logic.
3. **DuckDB is the common work surface.** Files, extension table functions, remote responses, graph edges,
   observations, and reductions become relations that SQL can inspect and join.
4. **Effects are injected and fail closed.** Network, compute, credentials, extension loading, filesystem policy,
   clocks, and deployment isolation belong to the host.
5. **Evidence is structural.** Runs retain declarations, receipts, replay material, CAS references, environment
   evidence, and temporal links when those facilities are supplied.
6. **Memory and knowledge share one temporal store.** `bio_observations` is append-only; graph tables and note files
   are projections.
7. **Graph work is action over data.** Query or write code over graph relations instead of serializing large
   neighborhoods into prompts.
8. **Judgment is narrow and typed.** Mechanical work stays in SQL or code. Ambiguous choices are validated against
   explicit candidates and may abstain.
9. **Reproducibility verdicts are honest.** Live sources and volatile functions remain visibly non-reproducible unless
   the relevant bytes and environment are pinned.
10. **Applications pull abstractions into core.** Domain policy stays downstream. Shared primitives enter core only
    after repeated concrete use exposes the same mechanism.

## Ownership

| Layer | Owns | Must not own |
|---|---|---|
| Core | validators, registries, runs, replay, CAS, observations, graph projection, async execution shapes | disease policy, UI workflow, source-specific product behavior |
| DuckDB adapters | resource materialization, SQL checks, extension binding, relation projection | question-specific analysis clients |
| Host adapters | credentials, network admission, process execution, stores, clocks, approvals, isolation | hidden scientific fallbacks |
| Applications | manifests, SQL relations, fixtures, rankings, review policy, packets, API and UI composition | duplicate runners, ledgers, queues, or graph substrates |
| Skills | thin procedural onboarding over public SDK surfaces | a separate executable client or one skill per question |
| Documents | concise explanations linked to implementation and proof | a second implementation, work diary, or unsupported claim |

The public SDK is the shared implementation. The CLI, Pi extension, Quarto engine, workbench, and future hosts adapt
that SDK rather than reimplementing execution semantics.

## Program model

A manifest declares available resolvers, resources, term sets, table names, and stable operations. It is serializable
and remains thin; it is not an imperative workflow diagram.

An ad-hoc query answers the current question. The actor describes the manifest, inspects relation schemas and bounded
samples, then writes read-only SQL. This is the default path for novel questions.

A query becomes a named operation when stable identity is useful for regression tests, replay, repeated workflows, or
a public interface. Naming does not make an analysis scientifically valid; declarations, evidence, and the analysis
do.

See [resources-and-tool-specs.md](resources-and-tool-specs.md) and [guide.md](guide.md).

## Execution model

### Data

Files and domain formats enter through DuckDB readers, extensions, or general SQL materialization. CAS stores immutable
bytes; a resource records how bytes or live data become a relation. Large evolving catalogs remain in suitable
relational storage, while the temporal ledger records their control-plane identity, snapshots, runs, and approvals.

DuckDB also holds the actor's working set. Temporary relations, graph projections, and CAS handles stay outside prompt
context and are inspected through bounded queries.

### Network

DuckNNG provides SQL-visible HTTP, RPC, and NNG communication when the host provisions it. Host-injected `http.get`
remains a fallback. One-response materialization, bounded fanout, retry, credentials, and service admission are
separate concerns; applications reuse the existing generic paths rather than adding API-specific clients.

### Compute

Compute uses `submit`, `status`, `collect`, and `cancel`. A local process, remote worker, scheduler, durable queue, or
stateful session is an implementation of that shape. `compute.run` materializes one declared result because a
relation-producing resolver needs a value. Durable applications compose task, step, and checkpoint records; resume
continues from the first missing content-pinned step rather than introducing another workflow engine.

### Knowledge and memory

Ontologies, foreign knowledge graphs, run provenance, memory links, and application relations use an edge-shaped SQL
vocabulary. `bio_edges_as_of` and `entailed_edge` support temporal traversal and closure without copying the graph into
prompt text.

See [duckdb-substrate.md](duckdb-substrate.md),
[ontology-and-knowledge-graphs.md](ontology-and-knowledge-graphs.md), and
[memory-and-knowledge-unification.md](memory-and-knowledge-unification.md).

## Runs, evidence, and identity

Human-readable identifiers aid discovery. Content digests establish byte identity. Schema or version tags belong at
real serialization, persistence, or IPC boundaries, not on every internal value.

A request is admitted before it becomes a run. Missing resources, unbound capabilities, or invalid SQL are preflight
errors. Once execution starts, success, failure, and cancellation produce auditable run evidence with whatever
receipts were created.

When CAS and a ledger are supplied, the host commit sequence is:

1. execute the query or operation and collect resolver receipts;
2. write immutable result, receipt, replay, and run-object bytes to CAS;
3. establish GC roots and atomic human-readable file views;
4. record declaration, run, and artifact observations; a required projection failure is surfaced;
5. write an action-cache entry only after live-source and hermeticity checks pass.

Files are legible views. CAS digests and ledger references are the durable identities when configured. CAS proves byte
identity, not freshness or truth. Replay distinguishes reproduced, diverged, and not reproducible.

Memoization is a scientific claim: a cache entry is allowed only when pinned inputs determine the result. The
physical plan must read resolved tables rather than ambient sources, SQL must avoid non-deterministic functions, and
introspection failure disables caching.

## Temporal state and judgment

`bio_observations` records revisions rather than mutating history. Current state is the latest valid row for a
`statement_key` at the requested time. Retraction and rollback append new observations. Graph edges, memory recall,
run state, approvals, and job checkpoints project from the same temporal mechanics without becoming semantically
identical.

Deterministic code mints identifiers, parses formats, computes candidates, applies mappings, and produces diffs. When
ambiguity remains, a model or human chooses from a typed candidate set. The host validates and records the choice and
may require approval before activation. Generated prose does not become measured data.

## Host and application boundaries

The package records and gates effects; it is not a sandbox. A deployment that requires stronger isolation supplies a
container, microVM, scheduler policy, credential broker, SQL authorizer, or network proxy and injects only approved
capabilities.

Browser conversation state is separate from scientific evidence. Interactive hosts own prompt, steering, abort, and
ephemeral activity. Durable scientific state moves through run ids, CAS references, checkpoints, observations, and
graph relations. Pi-specific control behavior remains in the Pi adapter until another host demonstrates a shared need.

Rendering is a view. Quarto or browser renderers consume content-addressed results and figure specifications; they do
not own scientific provenance or create facts.

## How core grows

1. Express the need in an application using existing manifests, SQL, ports, and evidence primitives.
2. Observe the same friction in another real use or executable pattern.
3. Name the shared mechanism without importing either application's policy.
4. Reconcile it with existing surfaces and delete the weaker boundary.
5. Promote the smallest general primitive with tests and public examples.
6. Return both consumers to the public SDK and remove private workarounds.

Unimplemented work with no current consumer, failing test, or executable proof does not belong in this document. Track
it as an issue or delete it until it becomes active.

## Proof and documentation

The proof hierarchy is:

1. focused tests establish one invariant;
2. executable manifests or QMD examples establish public composition;
3. hermetic application runs establish cross-boundary execution, evidence, resume, and abstention behavior;
4. pinned live-source runs establish current source compatibility;
5. budgeted benchmarks establish measured quality or cost improvement against a baseline.

A runnable example proves mechanics, not clinical validity or universal superiority. Generated Markdown is committed
for ordinary readers; QMD is the source when execution is part of the claim.

## Further reading

- [domain-model.md](domain-model.md): kernel types and admission rules.
- [concurrency.md](concurrency.md): local DuckDB ownership and remote shared-store access.
- [roadmap.md](roadmap.md): success criteria, proof levels, and active priorities.
- [refinments.md](refinments.md): demonstrated unresolved edges.
- [lineage.md](lineage.md): historical influences and the limits of comparisons.
