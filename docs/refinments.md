---
type: Worklog
title: Refinements
description: "Concrete sharp edges and consumer-pulled work that remain after core substrate closure."
tags: [refinements, open-issues, worklog]
---

# Refinements

This is a pressure ledger, not a feature queue. A refinement enters core only when a current consumer cannot express
the required behavior through manifests, SQL, graph projection, injected ports, async runners, observations, CAS,
or replay.

## Current sharp edges

### Reproduction portability

`reproduceRun` verifies the manifest file digest and reruns from `replay.manifest.path`. Relative file resources are
resolved to absolute paths before receipt hashing, so moving an otherwise identical checkout can produce false
drift. This fails safe: it cannot produce a false match. Snapshot-only replay and path-independent authored-resource
identity should be implemented together when a cross-machine consumer needs them.

Evidence: [reproduce.ts](../src/hosts/reproduce.ts), [reproduce.test.ts](../test/reproduce.test.ts).

### Live-source evidence

`duckdb.sql_materialize`, region reads, and process compute can depend on content that is not fully snapshotted.
Their receipts mark `live_source`; reproduction reports `notReproducible` unless output content is pinned in CAS.
Do not weaken this verdict. A future source adapter may add byte/range/object-version pins where the source exposes
them.

Evidence: [reproducibility.ts](../src/core/reproducibility.ts), [duckhts-region.test.ts](../test/duckhts-region.test.ts),
[reproduce.test.ts](../test/reproduce.test.ts).

### HTTP receipt detail

The injected HTTP resolver has cancellation, bounded body reads, retry, ETag/Last-Modified revalidation, and
scope-partitioned CAS reuse. Redirected final URL and an explicit `revalidatedAt` would improve audit detail when the
host fetch port exposes them. They are receipt additions, not a new network abstraction.

Evidence: [http-table-scan.ts](../src/duckdb/resolvers/http-table-scan.ts),
[http-cas-reuse.test.ts](../test/http-cas-reuse.test.ts).

### Shared CAS reuse leases

Shared CAS metadata supports refs, leases, tombstones, and GC. Resolver reuse does not yet take a metadata lease
around every cross-process read. Add that only for a deployment where concurrent shared GC and resolver reads use
the same metadata authority.

Evidence: [cas-metadata.ts](../src/hosts/cas-metadata.ts), [cas-metadata-gc.test.ts](../test/cas-metadata-gc.test.ts).

### Clock and generated identity

Wall-clock and generated run ids are host effects. Tests inject `now` where order matters. A host that requires
deterministic external identities can already supply `runId`; a universal clock/id port would touch broad surface
area and needs a real consumer.

### Product evidence packets

Core records runs, declarations, SQL digests, receipts, CAS reports/figures, graph links, approvals, and reproduce
verdicts. It does not impose one report or review-packet schema. Build the first packet in the workbench, then promote
only the repeated format-neutral projection.

Evidence: [artifacts.ts](../src/hosts/artifacts.ts), [declaration-graph.ts](../src/hosts/declaration-graph.ts),
[cli-reproduce.test.ts](../test/cli-reproduce.test.ts).

## Consumer-pulled adapters

- Scheduler backends for SLURM, `targets`, `mirai`, Modal, or another queue should implement `AsyncRunner` and the
  existing checkpoint contract.
- Runtime steer/interrupt/abort hooks should reduce host events to `recordHostEvent`; core should not invent an
  event taxonomy.
- External systems such as `rv`, ChEMBL, OpenTargets, BioBTree, Nextflow, or FHIR should first enter as resources,
  SQL materialization, graph projection, or `compute.run`.
- Cross-source node normalization should be added after two real KGs repeat the same identifier/category/label
  reconciliation.
- Renderer-specific report metadata and training labels belong to their first consumers.
- A DuckTinyCC-backed C-FFI or ducknng filesystem lane remains research until a manifest needs a table function that
  existing DuckDB extensions, process compute, or host adapters cannot supply.

## Closed contracts

Do not reopen these without contradictory evidence:

- provider-neutral catalog, manifest, query, operation, CLI, Pi, and SDK paths;
- parser/AST-backed read-only SQL and plan-based hermeticity checks;
- lazy resource forcing and `duckdb.sql_materialize` as the general SQL materializer;
- async compute plus durable queue, cancellation, leases, and checkpoint resume;
- CAS bytes, metadata refs/leases/GC, action cache, replay, and consumer-facing reproduce;
- required run/declaration/artifact evidence when a host supplies a ledger;
- open host events and digest-first training-corpus projection;
- graph projection profiles and the pinned SemanticSQL concrete-view compatibility contract;
- host-neutral skill installation and executable conformance checks;
- packed SDK consumer dogfood and owned-extension CI lanes.

The proof map and next application move are in [bring-it-home-plan.md](bring-it-home-plan.md).
