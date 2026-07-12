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

### Large result delivery

The SDK now returns the same JSON-safe `OperationResult` it persists, so an embedding consumer does not reopen
`result.json`. The current query runner still materializes the complete SQL result with `SqlConn.all`. Do not add a
hidden truncation cap. When the workbench needs a large result, add an explicit caller-selected delivery mode such as
inline rows versus a materialized relation/Parquet/CAS handle, while preserving the full persisted scientific result
and treating UI/model truncation as presentation metadata.

Evidence: [operations.ts](../src/core/operations.ts), [run-store.ts](../src/hosts/run-store.ts),
[sdk-host-embedding.qmd](../examples/patterns/sdk-host-embedding.qmd).

### Cross-host memory mutation parity

The SDK owns validated memory writes, retractions, recall, and history. Pi exposes both mutation and inspection,
while the CLI currently emphasizes inspection. Non-Pi hosts need a thin JSON/stdin CLI adapter for the same
`MemoryContent` and retraction contracts, with ordinary ledger receipts. This is surface parity over the existing
observation store, not a new memory service or file format.

Evidence: [memory-store.ts](../src/hosts/memory-store.ts),
[memory-store.test.ts](../test/memory-store.test.ts),
[typed-memory-agent.qmd](../examples/patterns/typed-memory-agent.qmd).

## Maintainer risk/perimeter matrix (core guarantees vs host obligations)

Use this as the deployment checklist before claiming a deployment-level behavior is covered.

| Concern | In-core guarantee | Host obligation |
|---|---|---|
| **Shared state topology (`SqlConn` / `openStore`)** | All ledger, memory, job, and run writes use injected SQL ports. The package ships a parameterized HTTP client/server and a typed Arrow/ducknng client adapter. HTTP requires bearer or authorization policy; ducknng supplies generated/in-memory/file-backed TLS and mTLS handles plus service admission. The default local store remains process-exclusive. | Terminate TLS for the HTTP reference, or configure ducknng's native TLS handle, peer policy, and SQL authorizer. Preserve serialized writes, or equivalent transaction semantics, for same-slot observation updates. |
| **Distributed run execution** | `createQueueJobWorker` claims leased replay jobs, heartbeats, rejects stale writes, records durable status/results, and recovers a terminal result without rerunning. The executing worker opens its own scientific DuckDB and calls `reproduceRun`; shared `SqlConn` is the coordination/evidence plane, not a bulk-result tunnel. | Stage declared inputs at the chosen manifest base, inject compute/network/secret policy and CAS, operate workers, and choose retry/shutdown policy. A deployment that wants the scientific database itself to be remote needs a host adapter beyond this worker composition. |
| **Live-source replay evidence** | Resolvers that cannot content-pin outputs annotate provenance as `live_source` (`duckdb.sql_materialize`, non-deterministic/uncertain `compute.run` paths). Reproduction with no output `resultDigest` does not produce `matched: true`; it reports `notReproducible`. Live-source runs are also excluded from ActionCache. | Hosts wanting deterministic replay on these sources must pass CAS and run in a mode where outputs are pinned. If CAS is absent, consume `notReproducible` as the stable truth and avoid treating the run as equality across time. |
| **Cross-machine replay portability** | Replay carries a canonical manifest snapshot and digest. Authored relative resource/compute paths remain relative in identity and resolve from an explicit `manifestBaseDir`; snapshot tampering and source/result/environment drift fail closed. Cross-checkout tests and the SSH worker pattern execute without the original manifest. | Stage the same input bytes under the selected base and re-supply protected config, capability receipts, compute environment, and CAS. Live sources remain subject to the evidence rule above. |

Cross-cutting constraints from this table are currently enforced by tests in:

- [reproduce.ts](../src/hosts/reproduce.ts), [reproduce.test.ts](../test/reproduce.test.ts)
- [run-store.ts](../src/hosts/run-store.ts), especially `serialize:false` CAS-rooting and live-source cache-skips
- [extensions/pi-coding-agent/index.ts](../extensions/pi-coding-agent/index.ts), `openStore` and session-sync guardrails
- [concurrency.md](./concurrency.md), [remote-sql-conn.ts](../src/hosts/remote-sql-conn.ts), and
  [pattern-ssh-remote-worker.mjs](../scripts/pattern-ssh-remote-worker.mjs)

## Consumer-pulled adapters

- Scheduler backends for SLURM, `targets`, `mirai`, Modal, or another queue should implement `AsyncRunner` and the
  existing checkpoint contract.
- The workbench now has a Pi-backed interactive host port for open/resume/rename, command discovery,
  prompt/steer/follow-up, abort, bounded transcripts, and ephemeral activity. Pi's extension already reduces durable input/lifecycle facts to
  `recordHostEvent` and imports the session transcript. Do not promote the browser event vocabulary into core. A
  second host adapter is the next test of whether any control contract beyond the current application port is shared.
- The workbench's explicit local-compute grant and evidence-status figure exercise the existing `compute.run` ->
  declared output -> CAS -> `run:<id> produces cas:<digest>` path. Direct process writes are not artifacts. This is
  application composition over the existing contract, not evidence for a plot-specific core tool.
- Clinical Evidence and Artifacts now exercise a host-approved `WorkbenchAddon` API/browser pair. Do not broaden it
  into an installation/catalog/configuration system until another deployment needs runtime discovery; do not add
  focus/resize/dock hooks until an editor, terminal, or comparable mounted surface requires them.
- External systems such as `rv`, ChEMBL, OpenTargets, BioBTree, Nextflow, or FHIR should first enter as resources,
  SQL materialization, graph projection, or `compute.run`.
- Cross-source node normalization should be added after two real KGs repeat the same identifier/category/label
  reconciliation.
- Renderer-specific report metadata and training labels belong to their first consumers.
- Fugu-shaped orchestration and RLM-shaped recursive model calls belong first in an application agent harness. The
  current access-list and map/reduce examples prove data-plane mechanics, not learned orchestration or
  machine-studying quality.
- A DuckTinyCC-backed C-FFI or ducknng filesystem lane remains research until a manifest needs a table function that
  existing DuckDB extensions, process compute, or host adapters cannot supply.

## Closed contracts

Do not reopen these without contradictory evidence:

- provider-neutral catalog, manifest, query, operation, CLI, Pi, and SDK paths;
- parser/AST-backed read-only SQL and plan-based hermeticity checks;
- lazy resource forcing and `duckdb.sql_materialize` as the general SQL materializer;
- async compute plus durable queue, cancellation, leases, and checkpoint resume;
- parameterized remote `SqlConn`, a lease-owning queue worker, and path-portable snapshot replay;
- CAS bytes, metadata refs/leases/GC, action cache, replay, and consumer-facing reproduce;
- required run/declaration/artifact evidence when a host supplies a ledger;
- open host events and digest-first training-corpus projection;
- graph projection profiles and the pinned SemanticSQL concrete-view compatibility contract;
- host-neutral skill installation and executable conformance checks;
- packed SDK consumer pattern and owned-extension CI lanes.

The current proof levels and application-driven next work are in [roadmap.md](roadmap.md).
