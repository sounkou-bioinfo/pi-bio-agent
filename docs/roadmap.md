---
type: Reference
title: Roadmap and success contract
description: "Current substrate closure, falsifiable success criteria, proof levels, and consumer-pulled next work."
tags: [roadmap, testing, success, applications]
---

# Roadmap and success contract

The roadmap is not a catalogue of possible agent features. Core grows when an executable application or host cannot
express a repeated motion through the current manifest, SQL, port, evidence, and temporal primitives.

## Current closure

The public substrate currently provides:

- manifest validation, resource resolution, schema discovery, ad-hoc read-only queries, and named operations;
- parser/AST-backed SQL validation and physical-plan hermeticity checks;
- DuckDB file scans, general SQL materialization, extension provisioning, and DuckHTS indexed region reads;
- host-injected HTTP plus DuckNNG HTTP, bounded fanout/retry/cancel, RPC shared state, and NNG transports;
- async compute through `submit/status/collect/cancel`, with Arrow values, declared files, and environment evidence;
- content-addressed storage, run-object DAGs, replay specs, action-cache eligibility, and explicit reproduce verdicts;
- one temporal observation ledger for memory, facts, sessions, runs, host events, jobs, and checkpoints;
- graph projections, as-of windows, closure, continuation, and foreign SemanticSQL-shaped sources;
- durable replay jobs, leases, heartbeats, step checkpoints, prefix resume, and remote-worker composition;
- typed judgment, approval, activation, rollback, and corpus export;
- a public SDK shared by CLI, Pi extension, Quarto engine, and first-party workbench.

This is sufficient to build applications. It is not a claim that every deployment adapter, biomedical policy, or UI
already exists.

## Falsifiable success

The project succeeds when an actor can answer a previously unprogrammed scientific question by inspecting declared
resources and composing SQL/code, while producing stronger evidence at lower implementation or inference cost than
a per-question skill baseline.

Every serious evaluation first gates correctness:

- claims are supported by declared data, deterministic compute, or explicit typed judgment;
- missing evidence is represented as missingness or abstention;
- receipts, replay, and environment evidence match the host's actual capabilities;
- live sources are not presented as byte-reproducible without pins;
- large data and graph state remain queryable rather than copied into prompts;
- clinical interpretation is not presented as model-generated fact.

Only then compare task accuracy, evidence quality, wall-clock time, token budget, tool calls, human review effort,
and implementation growth. Machine studying, multi-agent topology, and long-context decomposition become successes
only when a budgeted comparison shows gain; a runnable pattern alone proves mechanics.

## Proof levels

| Level | Establishes | Does not establish |
|---|---|---|
| Contract test | a validator or invariant is enforced | useful end-to-end composition |
| Executable QMD/manifest example | public surfaces compose and rendered claims are current | deployment or biomedical validity |
| Hermetic application run | cross-boundary workflow, evidence, resume, and abstention behavior | live-source compatibility |
| Pinned live-source run | source schema and host capability compatibility | future endpoint stability |
| Budgeted benchmark | measured quality/cost difference against a baseline | universal superiority |

Examples should state their level plainly. Recorded output copied into prose is not an additional proof level.

## Application-driven development

The first-party workbench is the active application pressure surface. Its clinical-genomics application composes
phenotype grounding, a pinned Monarch graph, assembly-aware intervals, indexed VCF reads, bounded VEP annotation,
SQL evidence reconciliation, checkpoints, CAS, ledger links, and review boundaries.

When the same friction appears in another application or generic pattern, promote the smallest format-neutral
primitive to core. The bounded DuckNNG HTTP fanout resolver followed this path. Clinical ranking policy, phenotype
semantics, coverage states, and review packets have not crossed that threshold and remain downstream.

## Consumer-pulled lanes

Near-term work should be selected from demonstrated pressure in these lanes:

- **Workbench surfaces:** human review, evidence exploration, report graphics, and long-running task UX over the
  existing SDK and durable job lifecycle.
- **Scientific action catalogs:** ingest Biomni-like method/tool descriptors into generated manifest/catalog relations;
  let actors discover actions with SQL/FTS/graph queries, filter by data/software/license/capability constraints,
  execute candidates through compute or source-spec adapters, and compare durable results. The action count is not the
  problem; handwritten duplicate runners and missing output/evidence contracts are.
- **Cross-host parity:** thin validated adapters for memory mutation, session ingestion, and host capability binding
  outside Pi.
- **Large results:** explicit relation, Parquet, or CAS delivery modes instead of implicit full in-memory rows.
- **Remote deployment:** production SQL/store adapters, artifact retrieval, worker admission, and operational TLS
  profiles without changing core scientific semantics.
- **Foreign graph exercises:** real SemanticSQL projections over Biolink/KGX, semantic web, FHIR, and GraphQL-shaped
  systems, preserving qualifiers and source evidence.
- **Evaluation:** weaker-agent and human-legibility studies, RLM/Fugu-like harnesses, and application benchmarks that
  measure cost and quality instead of only execution.

Concrete unresolved edges live in [refinments.md](refinments.md).

## Repository gate

`npm run check:all` is the local package gate. It covers core, workbench, Quarto engine, generated documentation,
examples, skills, type checking, and tests. Focused changes should run their owning test or executable QMD first;
shared contract changes should run the full gate.

Documentation with executable claims is authored as QMD and rendered to committed Markdown. Design prose links to
code, tests, or application runs. The generated docs index must remain current.
