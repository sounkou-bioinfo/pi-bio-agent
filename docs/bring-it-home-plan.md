---
type: Proposal
title: Bring-it-home plan — core substrate closure
description: "Core-library closure ledger after the workbench split: proven substrate capabilities, honest limits, and the downstream work that should pull any next abstraction."
tags: [roadmap, substrate, host-events, jobs, graph-projection, artifacts, corpus, ducknng]
---

# Bring-it-home plan — core substrate closure

`pi-bio-agent` is the open substrate, not the workbench product. Its job is to carry declared resources into DuckDB
relations, agent-authored SQL, optional async compute, recorded runs, observation links, CAS artifacts, and
replay/reproduction without an application bypassing evidence.

The workbench owns domain pipelines, review rubrics, evidence packets, UI, and deployment policy. A new core
primitive is justified only when a real downstream path cannot fit the sequence above without bypassing evidence or
reimplementing a substrate contract.

## Current verdict

The base substrate is ready for a serious downstream workbench. The remaining product gap is not another resolver
taxonomy or workflow engine. It is an application that composes the existing data, network, compute, graph,
judgment, provenance, and replay surfaces around a real scientific task.

The core claims below have executable evidence:

| Capability | Implemented contract | Evidence |
|---|---|---|
| Manifest and SQL program | Strict manifest admission, schema discovery, lazy resource forcing, ad-hoc read-only queries, named SQL operations | [manifest.ts](../src/core/manifest.ts), [operations.ts](../src/core/operations.ts), [host-run-operation.test.ts](../test/host-run-operation.test.ts) |
| Truthful host admission | Manifest declarations are separate from `ready` / `blocked` / `unknown` host assessment; unbound ports and unattested extensions are not called runnable | [manifest-capabilities.ts](../src/hosts/manifest-capabilities.ts), [manifest-capabilities.test.ts](../test/manifest-capabilities.test.ts) |
| Data, network, compute | Files and SQL materialization, DuckHTS range reads, ducknng HTTP/RPC profiles, injected `http.get`, and injected async `compute.run` | [duckdb-substrate.md](duckdb-substrate.md), [duckhts-read-bcf.test.ts](../test/duckhts-read-bcf.test.ts), [compute-run-example.test.ts](../test/compute-run-example.test.ts) |
| One async lifecycle | `submit/status/collect/cancel`, durable queue and ledger backends, a lease-owning worker, cancellation, stale-write rejection, and checkpoint-prefix resume | [ports.ts](../src/core/ports.ts), [queue-job-worker.ts](../src/hosts/queue-job-worker.ts), [job-store.ts](../src/hosts/job-store.ts), [queue-job-worker.test.ts](../test/queue-job-worker.test.ts), [python-workflow-dogfood.test.ts](../test/python-workflow-dogfood.test.ts) |
| Required run evidence | When a host supplies a ledger, run facts and artifact projections are required; failures surface with the persisted run path | [run-store.ts](../src/hosts/run-store.ts), [run-observations.test.ts](../test/run-observations.test.ts) |
| CAS and replay | Content-addressed results/receipts/replay/run objects, metadata refs/leases/GC, action cache, and path-portable snapshot reproduction | [fs-cas.ts](../src/hosts/fs-cas.ts), [cas-metadata.ts](../src/hosts/cas-metadata.ts), [reproduce.ts](../src/hosts/reproduce.ts), [reproduce.test.ts](../test/reproduce.test.ts) |
| Cross-host composition | Exact parameterized `SqlConn` transport with required authorization and serialized execution; a fresh SSH worker installs the package, claims a replay, and verifies source/result digests without the original manifest | [remote-sql-conn.ts](../src/hosts/remote-sql-conn.ts), [remote-sql-conn.test.ts](../test/remote-sql-conn.test.ts), [dogfood-ssh-remote-worker.mjs](../scripts/dogfood-ssh-remote-worker.mjs) |
| Consumer verification | `pi-bio-agent reproduce` and `bio_reproduce_run` rerun a replay on a fresh database and report concrete source/result/environment drift | [reproduce.ts](../src/cli/reproduce.ts), [cli-reproduce.test.ts](../test/cli-reproduce.test.ts), [pi-extension.test.ts](../test/pi-extension.test.ts) |
| One temporal graph | Runs, host events, memory, sessions, jobs, declarations, and artifacts are observations; edge-like facts project to `bio_edges_as_of` | [observations.ts](../src/duckdb/observations.ts), [declaration-graph.ts](../src/hosts/declaration-graph.ts), [declaration-graph.test.ts](../test/declaration-graph.test.ts) |
| Foreign and ontology graphs | Generic projection profiles cover KGX/external tables and internal observations; SemanticSQL concrete view names are pinned to an upstream commit and exercised in DuckDB | [graph-projection.ts](../src/core/graph-projection.ts), [semantic-sql.ts](../src/duckdb/semantic-sql.ts), [graph-projection.test.ts](../test/graph-projection.test.ts), [monarch-kg-http-example.test.ts](../test/monarch-kg-http-example.test.ts) |
| Reports and figures | Declared R/Python/bash outputs stream into CAS and become ordinary artifact facts and `produces` edges | [artifacts.ts](../src/hosts/artifacts.ts), [compute-artifacts-example.test.ts](../test/compute-artifacts-example.test.ts), [artifact-observations.test.ts](../test/artifact-observations.test.ts) |
| Host-neutral agent use | The CLI describes host admission and explicitly composes fetch, local compute, CAS, protected state, and replay; one procedural skill and installer serve Pi, Codex, Claude, OpenCode, Copilot, and custom roots | [SKILL.md](../skills/pi-bio-agent/SKILL.md), [run.ts](../src/cli/run.ts), [cli-describe.test.ts](../test/cli-describe.test.ts), [skill-install.test.ts](../test/skill-install.test.ts) |

## Proof commands

The normal gate and compact consumer paths are:

```sh
npm run check
npm run dogfood:bring-it-home
npm run dogfood:sdk-host-embedding
npm run dogfood:substrate-skill
```

The cross-machine proof is opt-in because it needs an SSH host with reverse forwarding:

```sh
npm run dogfood:ssh-remote-worker
```

The extension-backed lanes are explicit because they exercise real host environments:

```sh
npm run provision:duckhts
npm run provision:ducknng-owned
npm run dogfood:ducknng-upload
```

CI provisions R plus DuckHTS for the full suite. A separate owned-ducknng job requires retry, subject-scoped HTTP
profiles, upload, TLS, RPC, and socket behavior. A missing capability is a failed job, not a green skipped lane.

## Work that belongs downstream first

1. **Scientific application.** Build one end-to-end workbench path against the package API. For rare-disease work,
   the direct lane (variant to gene/disease) and inverted lane (phenotype to disease/gene to variant support) should
   reconcile into one evidence relation with explicit missingness, contradiction, abstention, and review.
2. **Evidence and report product.** Compose run receipts, SQL, source versions, CAS figures, graph links, reproduce
   verdicts, and approvals into a reviewable packet. Renderer-specific schemas and UI models belong here first.
3. **Training corpus contract.** A real consumer must define labels, redaction, examples, and typed Parquet output.
   Core already exposes the digest-first ledger projection; it should not invent labels in advance.
4. **Scheduler adapters.** SLURM, `targets`, `mirai`, Modal, or another backend should implement the existing async
   lifecycle and checkpoint semantics. They do not justify a second workflow abstraction.
5. **Runtime host adapters.** Interrupt, abort, steer, and approval events should be recorded through
   `recordHostEvent` when a host exposes stable events and a consumer reads them.
6. **Cross-source node identity.** Monarch, OpenTargets, BioBTree, and similar sources may pull a normalized node
   view for categories, labels, equivalent identifiers, and source ids. Edge qualifiers remain metadata until a
   concrete inference or reconciliation policy consumes them.

## Non-goals

- A per-question biomedical helper or skill.
- A second process-operation transport beside `compute.run`.
- A second workflow lifecycle beside `AsyncRunner` plus checkpoints.
- SQL string guards presented as filesystem, network, credential, or tenant isolation.
- Full behavioral equivalence with every moving SemanticSQL generator. The supported concrete view-name contract is
  pinned; DuckDB adaptations are tested locally and expanded only with source or consumer pressure.
- A generic workbench framework before the first application works end to end.

## Next move

Start the API-first workbench as a sibling consumer. Keep clinical genomics as the first demanding binding, not the
identity of the framework. Let its real direct/inverted analysis, evidence review, reports, and UI reveal the next
missing primitive. If it composes cleanly, leave core alone.
