---
type: Reference
title: Memory and knowledge in one temporal ledger
description: "Implemented mechanics for memory revisions, typed links, observations, graph projection, and session ingestion."
tags: [memory, observations, temporal, graph, sessions]
---

# Memory and knowledge in one temporal ledger

`pi-bio-agent` has one durable temporal substrate: `bio_observations`. Memory notes, typed relations, run facts,
host events, job checkpoints, and imported session events use the same append-only mechanics. They retain distinct
payload contracts and provenance; they do not require distinct storage systems.

## Source of truth and projections

```text
typed SDK or host tool
  -> append observation revision(s)
  -> bio_observations
       -> recall/history views
       -> bio_edges_as_of
       -> graph windows and closure
       -> optional human-readable note files
```

`bio_observations` is the source of truth. `bio_edges_as_of` is a current-time graph projection. Files under a
study-notes directory are optional derived views for humans and simple host integration; editing or copying them is
not the ledger protocol.

## Observation model

An observation records a subject, predicate, temporal instant, author/source, and one of a scalar value, object
relation, structured payload, or tombstone. Content-addressed ids make equivalent observations identifiable while
the instant preserves revision order.

The ledger supports:

- append-only history;
- current as-of projection;
- explicit retraction rather than destructive deletion;
- attribution and source metadata;
- typed object relations that can become graph edges;
- shared querying across memory, runs, sessions, and application facts.

The payload schema still matters. A memory revision is not interchangeable with a measured biomedical fact merely
because both are observations.

## Memory writes

`remember` accepts validated `MemoryContent`: slug, kind, title, hook, body, optional tags, and typed links. The write
path canonicalizes slugs and link targets before touching DuckDB. It appends:

1. the current content revision for `memory:<slug>`;
2. link observations from that subject to canonical `memory:<target>` ids.

Unqualified links default to `references`; explicit predicates such as `depends_on` or `see_also` remain typed.
A later revision replaces the current link set in the as-of projection without deleting earlier history.

Concurrent writes to one slug use a compare-and-set insertion against the current slot maximum. On a serialized
shared SQL lane, one writer advances the slot and conflicting writers re-read and retry. This prevents tied current
revisions and lost updates without introducing a separate memory service.

`forget` appends a tombstone. It does not erase history.

## Recall and graph walk

`recall` returns the current content revision. `memoryHistory` returns prior revisions. The Pi tools expose these as
recall and history operations; SDK hosts call the same implementation.

`bio_walk_memory` and `bio_graph_window` operate over the same projected relations. A current memory link therefore
has one representation, whether reached through memory-specific ergonomics or a general graph query. Large walks
are paged or continued; they are not serialized wholesale into the model prompt.

## Runs, jobs, and sessions

Run storage records observations that connect tool calls, runs, manifests, operations, artifacts, results, and host
events. Durable jobs append status, lease, checkpoint, and terminal observations. Session import translates the
source host's events into typed observations and preserves source identifiers and raw evidence where needed.

Pi JSONL has a first-party ingestion adapter because the extension can observe its lifecycle directly. Other hosts
can use the same generic pattern:

1. parse the host's stable session/event format;
2. validate and normalize events into observation inputs;
3. retain source ids and digests;
4. append through the public SDK;
5. derive trajectories or graph links with SQL.

The adapter is host-specific; the ledger is not.

## Cross-process access

The default local DuckDB store supports concurrent tools and hooks in one process through one process-cached native
instance and independent connections. It remains exclusive across processes. Multiple processes or hosts share the
logical ledger by injecting a remote `SqlConn`, including the parameterized HTTP reference server or a DuckNNG
RPC-backed connection. The observation and memory APIs do not change with topology.

Transport security, SQL authorization, credentials, TLS, and service admission are host responsibilities. See
[concurrency.md](concurrency.md).

## Memory and scientific evidence

Memory can hold a study map, rubric, schema note, prior plan, or interpretation. It is authored context, not measured
truth. A scientific claim should link to the run, source, artifact, or recorded judgment that supports it.

Useful distinctions remain explicit:

| Kind | Meaning | Typical evidence |
|---|---|---|
| Memory | authored context intended for later use | author, revision, links |
| Fact | asserted relation or value | source, run, receipt, confidence |
| Judgment | typed choice at an ambiguity boundary | candidates, actor, rubric, approval |
| Run event | execution history | tool call, manifest, operation, receipt |
| Checkpoint | completed durable step | replay digest, result/CAS references |

One temporal store unifies querying and provenance; it does not erase these semantic differences.

## Public surfaces

- SDK: write, retract, recall, history, observe, project, and ingest.
- Pi extension: memory, graph, run, and session tools over the SDK.
- CLI: query and inspect ledger/graph surfaces; write parity should remain a thin validated SDK adapter rather than a
  second implementation.
- Quarto and applications: call the SDK or CLI and render results; presentation helpers do not create evidence.

## Non-goals

- hidden vector memory controlled by the model provider;
- a second memory database beside the observation ledger;
- prompt injection of complete graph neighborhoods;
- treating note text as biomedical evidence;
- mutable in-place deletion of history;
- a universal ontology of every observation payload.

The implemented abstraction is intentionally small: append typed temporal observations, project the relations
needed now, and keep source evidence addressable.
