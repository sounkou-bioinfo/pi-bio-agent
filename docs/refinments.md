---
type: Worklog
title: Refinements
description: "Concrete sharp edges and consumer-pulled work that remain after core substrate closure."
tags: [refinements, open-issues, handoff, worklog]
---

# Refinements

This file contains only demonstrated gaps that remain relevant to a current consumer. It is not a feature queue.
Remove an item when it is closed, superseded, or no longer active. Reintroduce deferred work only with a named
consumer, failing test, or executable proof.

## Active sharp edges

### Cross-session development handoff

`AGENTS.md`, the generated docs index, Git history, tests, issues, and PRs already provide strong durable context. The
remaining gap appears when implementation stops mid-branch: objective, exact verification state, unresolved decisions,
and the first correct next action can remain trapped in the preceding chat or in unstated local knowledge.

The current consumers are coding agents and human maintainers transferring incomplete work. The smallest mechanism is
a branch-scoped `.handoff/current.json` packet that points to existing sources of truth. It is not a runtime feature,
project memory database, transcript store, or canonical design document.

Evidence and ownership:

- [handoff.md](handoff.md) defines the transfer contract and source-of-truth order;
- `.handoff/handoff.schema.json` and `.handoff/current.example.json` define the bounded packet;
- `AGENTS.md` defines takeover, verification, knowledge-promotion, and deletion rules;
- the PR template carries the completed human-readable projection.

The active proof gap is a cold handoff exercise on real incomplete work. A fresh contributor should identify the
objective, verify the current boundary, and take one correct next action without reading the previous conversation or
opening unrelated files. Add automated validation only after real packets reveal which constraints are stable.

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
it does not remove the runner's in-memory materialization. Add a relation, Parquet, or CAS result mode only when a
current consumer needs it.

Evidence: [operations.ts](../src/core/operations.ts), [run-store.ts](../src/hosts/run-store.ts),
[sdk-host-embedding.qmd](../examples/patterns/sdk-host-embedding.qmd), and
[packages/mcp-server](../packages/mcp-server/README.md).

### Stateful cross-host control

The stateless MCP adapter now exercises provider-neutral manifest inspection, capability admission, query, operation,
evidence retrieval, and replay through the public SDK. It intentionally has no conversation session, transcript,
steering, or dynamic-tool lifecycle. A second stateful host is still required before Pi's interactive control behavior
can become a shared contract.

Evidence: [packages/mcp-server](../packages/mcp-server/README.md),
[memory-store.ts](../src/hosts/memory-store.ts), and
[typed-memory-agent.qmd](../examples/patterns/typed-memory-agent.qmd).

## Deployment boundaries

| Concern | Library guarantee | Host responsibility |
|---|---|---|
| Local and shared DuckDB ownership | same-process ledger opens share one cached instance; isolated scientific file runs serialize; remote stores use injected `SqlConn` | provide one writer authority across processes, authorize SQL, and configure TLS/service admission |
| Distributed replay | workers claim leased jobs, heartbeat, reject stale writes, and reproduce from manifest snapshots | stage inputs, supply network/compute/secrets/CAS, and operate worker retry and shutdown policy |
| Stateless MCP | each modern HTTP request receives a fresh protocol server; tools reuse the public scientific SDK; no MCP session ID is created | authenticate requests, validate Host/Origin, terminate TLS, bind credentials/capabilities, and provide OS/network isolation |
| Live-source replay | live inputs remain marked non-reproducible without sufficient pins and are excluded from action caching | supply content pins or consume `notReproducible` as the result |
| Cross-machine portability | replay carries a manifest snapshot, relative paths, digests, and environment evidence | stage matching bytes and resupply protected host configuration and capabilities |
| Development handoff | the repository defines a bounded branch packet, source-of-truth order, and verification vocabulary | keep the packet current at transfer boundaries, avoid secrets, and promote durable knowledge before merge |

Primary execution evidence is in [concurrency.md](concurrency.md), [reproduce.ts](../src/hosts/reproduce.ts),
[reproduce.test.ts](../test/reproduce.test.ts), [run-store.ts](../src/hosts/run-store.ts),
[packages/mcp-server](../packages/mcp-server/README.md), and
[pattern-ssh-remote-worker.mjs](../scripts/pattern-ssh-remote-worker.mjs).

Shared-CAS read leases, richer HTTP receipt fields, scheduler adapters, additional renderers, and other integration
ideas remain deferred until a current deployment demonstrates the need. They do not stay expanded in living design
docs while inactive.

## Admission rule

A proposal belongs in this worklog only when all of the following are true:

1. a current application, deployment, or development workflow is blocked or carrying a concrete workaround;
2. the gap cannot be expressed through existing manifests, SQL, injected capabilities, observations, CAS, replay,
   Git/PR state, or the branch handoff contract;
3. code, a failing test, an executable pattern, or a cold handoff exercise identifies the boundary;
4. the proposed change is the smallest policy-free mechanism that closes it.

Otherwise track the idea in an issue or delete it. Proven surfaces are reopened only by contradictory evidence, not by
association with another framework or a speculative future integration.

Current priorities and proof levels are in [roadmap.md](roadmap.md).
