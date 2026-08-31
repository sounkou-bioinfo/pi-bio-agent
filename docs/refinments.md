---
type: Worklog
title: Refinements
description: "Concrete sharp edges and consumer-pulled work that remain after core substrate closure."
tags: [refinements, open-issues, worklog, control-plane]
---

# Refinements

This file contains only demonstrated gaps that remain relevant to a current consumer. It is not a feature queue.
Remove an item when it is closed, superseded, or no longer active. Reintroduce deferred work only with a named
consumer, failing test, or executable proof.

## Active sharp edges

### Fragmented operational orientation

The public substrate exposes exact manifests, schemas, runs, queue rows, observations, receipts, and replay objects,
but an agent still has to reconstruct the current operational situation across several surfaces. Pi and the workbench
are current consumers for one bounded situation snapshot with stable handles, change cursors, blocked reasons,
capacity/budget risk, evidence gaps, and legal next actions.

The snapshot must remain a projection over existing declarations, operational tables, CAS, and `bio_observations`.
It must not become another lifecycle or storage layer.

Evidence: [design.md](design.md), [jobs.ts](../src/core/jobs.ts),
[job-queue.ts](../src/hosts/job-queue.ts), and the workbench run surfaces.

### DuckDB-specific durable queue

The current leased queue is intentionally small and correct for one serialized DuckDB SQL lane. The R single-node
scheduler and distributed worker use cases now require the same behavior over SQLite and PostgreSQL, with
server-owned DuckDB/Quack as an explicit additional profile.

The gap is not generic SQL syntax. It is a versioned behavioral contract covering idempotent admission, claims,
fencing, heartbeats, park/resume, terminal recovery, control intent, and observation envelopes under different
transaction models.

Evidence: [job-queue.ts](../src/hosts/job-queue.ts),
[queue-job-worker.ts](../src/hosts/queue-job-worker.ts),
[job-queue.test.ts](../test/job-queue.test.ts), and [concurrency.md](concurrency.md).

### Resource-aware admission

Current workers bound concurrency by executor slots, not by a shared named capacity vector. The active R/local-node
consumer needs priority-aware admission across CPU, memory, GPU, and arbitrary tokens without creating independent
semaphores or routing every request into a hand-built worker class.

The smallest shared mechanism is:

```text
capacity request + budget + placement constraints + priority
  -> atomic claim and allocation
  -> fenced attempt
  -> executor-confirmed release
```

Hard CPU, memory, device, and process-tree enforcement remains a host/executor concern.

Evidence: the existing durable queue and worker, the current single-node resource-allocation design, and
[roadmap.md](roadmap.md).

### Control intent versus observed termination

`cancelQueuedJob()` prevents future claims but does not itself prove that a running process or remote computation
stopped. Agent control needs an explicit durable cancel intent, worker acknowledgement, observed terminal state, and
allocation release only after execution is fenced or confirmed stopped.

This distinction also applies to pause, resume, reprioritize, and future budget changes. A command receipt is not a
state receipt.

Evidence: [job-queue.ts](../src/hosts/job-queue.ts),
[queue-job-worker.ts](../src/hosts/queue-job-worker.ts), and the process-runner cancellation tests.

### Evidence-driven operation promotion

Runs already retain replay, receipts, environment evidence, results, artifacts, and observations. They do not yet
produce a compact empirical profile that an agent can query when choosing among equivalent plans, nor a standard
promotion candidate that turns repeated ad-hoc SQL/compute into a versioned operation with regression evidence.

The current consumer is the agent authoring loop itself: it should reuse demonstrated work rather than spend tokens and
compute rediscovering the same operation. Promotion remains proposal plus validation plus approval; no automatic code
or permission mutation is allowed.

Evidence: [design.md](design.md), [roadmap.md](roadmap.md), run/replay stores, and the manifest governance patterns.

### Live-source evidence

`duckdb.sql_materialize`, indexed region reads, and process compute can depend on content that is not fully
snapshotted. Their receipts mark `live_source`; reproduction reports `notReproducible` unless output content is pinned
in CAS. Do not weaken that verdict. Add byte, range, object-version, or snapshot pins only where a source can support
them honestly.

Evidence: [reproducibility.ts](../src/core/reproducibility.ts),
[duckhts-region.test.ts](../test/duckhts-region.test.ts), and
[reproduce.test.ts](../test/reproduce.test.ts).

### Large result delivery

The SDK returns the same JSON-safe result it persists, but the query runner still materializes every row through
`SqlConn.all`. The MCP adapter makes inline versus reference delivery explicit without truncating the persisted result;
it does not remove the runner's in-memory materialization. Add a relation, Parquet, Arrow, or CAS result mode when the
situation snapshot, R client, or another current consumer needs it.

Evidence: [operations.ts](../src/core/operations.ts), [run-store.ts](../src/hosts/run-store.ts),
[sdk-host-embedding.qmd](../examples/patterns/sdk-host-embedding.qmd), and
[packages/mcp-server](../packages/mcp-server/README.md).

### Stateful cross-host control

The stateless MCP adapter exercises provider-neutral manifest inspection, capability admission, query, operation,
evidence retrieval, and replay through the public SDK. It intentionally has no conversation session, transcript,
steering, or dynamic-tool lifecycle.

The R durable client is now the second candidate stateful host for repeated control behavior. Promote only the shared
parts: stable object handles, situation snapshots, plan/preflight, observe cursors, typed control intents, collect,
replay, compare, and promotion proposals. Prompt/session semantics remain host-specific.

Evidence: [packages/mcp-server](../packages/mcp-server/README.md),
[memory-store.ts](../src/hosts/memory-store.ts), [design.md](design.md), and
[typed-memory-agent.qmd](../examples/patterns/typed-memory-agent.qmd).

## Deployment boundaries

| Concern | Library/protocol guarantee | Host responsibility |
|---|---|---|
| Scientific DuckDB ownership | same-process ledger opens share one cached instance; isolated scientific file runs serialize; remote scientific stores use injected `SqlConn` | provision extensions, authorize SQL, and avoid unsupported mixed native versions |
| Durable control semantics | versioned jobs, attempts, leases, fencing, park/resume, terminal recovery, and observation envelopes pass backend conformance tests | choose and operate SQLite, PostgreSQL, or a server-owned DuckDB lane; run migrations and backups |
| Resource admission | complete capacity vectors are reserved atomically and blocked reasons are explainable | discover real capacity, enforce CPU/memory/device limits, stage data, and contain process trees |
| Cancellation | intent and observed terminal effect are distinct; stale attempts cannot publish | stop or fence actual work and confirm termination before capacity release |
| Local R/SQLite | one-node reference adapter uses short DBI transactions and a pure-R policy layer | own worker processes, WAL/local-storage deployment, logs, and OS enforcement |
| Distributed PostgreSQL | concurrent claims and allocations are transactional and fenced | operate PostgreSQL, TLS, credentials, worker lifecycle, monitoring, and recovery |
| DuckDB/Quack | DuckDB is a joined inspection plane; server-owned write profiles may implement the protocol | provide one writer authority and accept the maturity of the selected protocol |
| Distributed replay | workers reproduce from manifest snapshots and content-pinned checkpoints | stage matching inputs, supply network/compute/secrets/CAS, and operate retry/shutdown policy |
| Stateless MCP | each HTTP request receives a fresh protocol server; tools reuse the public scientific SDK | authenticate requests, validate Host/Origin, terminate TLS, bind capabilities, and provide OS/network isolation |
| Live-source replay | live inputs remain non-reproducible without sufficient pins and are excluded from action caching | supply content pins or consume `notReproducible` as the result |
| Cross-machine portability | replay carries manifest snapshot, relative paths, digests, and environment evidence | stage bytes and resupply protected configuration and capabilities |

Primary evidence is in [concurrency.md](concurrency.md), [reproduce.ts](../src/hosts/reproduce.ts),
[reproduce.test.ts](../test/reproduce.test.ts), [run-store.ts](../src/hosts/run-store.ts),
[packages/mcp-server](../packages/mcp-server/README.md), and
[pattern-ssh-remote-worker.mjs](../scripts/pattern-ssh-remote-worker.mjs).

Shared-CAS read leases, preemption, fair-share, EASY backfill, automatic topology-aware placement, and other policies
remain deferred until a current deployment demonstrates the need. They do not stay expanded in living design docs
while inactive.

## Admission rule

A proposal belongs in this worklog only when all of the following are true:

1. a current application or deployment is blocked or carrying a concrete workaround;
2. the gap cannot be expressed through existing manifests, SQL, injected capabilities, observations, CAS, replay, or
   the durable-control contract;
3. code, a failing test, executable pattern, or cross-language conformance fixture identifies the boundary;
4. the proposed change is the smallest policy-free mechanism that closes it;
5. the change preserves one lifecycle, one ledger, and stable agent-facing handles.

Otherwise track the idea in an issue or delete it. Proven surfaces are reopened only by contradictory evidence, not by
association with another framework or a speculative future integration.

Current priorities and proof levels are in [roadmap.md](roadmap.md).
