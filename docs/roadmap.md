---
type: Reference
title: Roadmap, success, and testing contract
description: "Read before planning roadmap, success metrics, tests, or flagship work; current core closure and consumer-pulled lanes."
tags: [roadmap, testing, success, flagship]
---

# Roadmap, success, and testing contract

This document is the planning contract. The detailed current closure ledger is
[`bring-it-home-plan.md`](./bring-it-home-plan.md); do not duplicate that evidence here.

## What We Are Building

`pi-bio-agent` is a library for agent-controlled scientific computation over DuckDB:

- manifests declare resources, resolvers, operations, effects, and reproducibility hints;
- resolvers materialize declared data into DuckDB relations with receipts;
- agents inspect schemas and compose read-only SQL;
- optional compute runs out of process through a host-injected async runner;
- runs, host events, memory, facts, graphics, reports, and artifacts become observations and CAS handles;
- graph-shaped knowledge is queried as tables: `bio_edges`, `bio_edges_as_of`, and `entailed_edge`.

The model or human may route, inspect, compose, and judge. It is not the source of biomedical facts. Facts come from
declared data, deterministic compute, receipts, CAS artifacts, and recorded approvals.

Core owns contracts, validators, registries, receipts, replay, CAS, graph/observation storage, and host-injected
effect ports. Applications own manifests, operation packs, UI, domain datasets, review rubrics, report packets, and
deployment policy.

## Falsifiable Success

The project succeeds only if the substrate lets an agent produce better-supported scientific answers with less
inference/tool budget than a baseline that lacks the manifest/SQL/graph/provenance apparatus.

Every serious run is gated first:

- provenance is correct;
- biomedical claims are supported by declared data or explicit recorded judgment;
- no diagnosis or clinical recommendation is presented as a model fact;
- receipts, replay specs, and environment evidence are present where the host can provide them;
- tool/code/network/credential effects are host-granted and fail closed when unavailable;
- large data, graphs, and artifacts remain queryable/addressable rather than pasted into prompt context.

Only after those gates does a benchmark compare accuracy, evidence quality, wall-clock, token budget, and tool-call
budget. This is the machine-studying claim made operational: the apparatus should improve the cost curve, not just
add metadata.

## Testing Contract

`npm run check` is the single local gate. It runs typecheck, the full test suite, docs/index drift checks,
example-readme drift checks, README tool-list checks, and skill validation.

The test pyramid is now real:

- **Pure contract tests**: validators, canonical digests, graph/profile specs, run specs, env descriptors.
- **SQL/KG tests**: read-only SQL validation, plan hermeticity, SemanticSQL views, closure, graph projection.
- **Effect tests**: local file/CAS/run ledger, CLI, memory, artifacts, DuckDB init/config, host policies.
- **Application-operation tests**: connector manifests, coloc, rare-high-impact, compute examples, OpenTargets,
  Monarch KG HTTP, DuckHTS range reads.
- **Flagship/dogfood tests**: bring-it-home, SDK host embedding, substrate skill, Pi session trace, ducknng upload
  when the sibling extension is available.
- **Harness-adaptation tests**: approvals, activate/rollback, temporal skills, package skill validation and install
  presets, Pi extension tool registration and lifecycle receipts.

For roadmap work, add a focused test first when the behavior is a contract. For docs-only cleanup, run
`npm run docs:index`, `npm run check:docs`, and any README/example generator affected by the edit.

## Current Core Status

Core is closed over the main primitives needed by a downstream workbench:

- provider-agnostic manifest/query/run path;
- read-only SQL guard plus plan hermeticity;
- lazy resource forcing;
- host-injected network and compute ports;
- SQL-native network through ducknng and host-owned HTTP profiles;
- `duckhts.read_bcf` range reads;
- `compute.run` over async runner semantics with table, file, and files-only artifact outputs;
- CAS byte store, shared CAS metadata, refs, leases, and GC;
- replay/reproduce/action-cache contracts;
- durable job queue, cancellation, and checkpoint resume;
- open `recordHostEvent` facts and redacted training-corpus export;
- graph projection profiles and the pinned SemanticSQL concrete-view compatibility contract;
- figures/reports/session images as CAS-addressed artifacts linked through observations;
- SDK base exports checked by a packed external-consumer dogfood;
- packaged host-neutral skill plus installer presets for Pi, Codex, Claude, OpenCode, and GitHub Copilot.

The compact evidence commands are:

```sh
npm run dogfood:bring-it-home
npm run dogfood:sdk-host-embedding
npm run dogfood:substrate-skill
```

Run `npm run dogfood:pi-session-trace` when Pi/model credentials are configured and a session-level integration
check is needed.

## Flagship Role

The rare-high-impact variant example remains the minimal safety skeleton: count only documented-rare high-impact
variants, abstain on missing frequency, exclude benign loss-of-function calls, and prove the answer by SQL over
declared resources. Its purpose is to prevent skill sprawl and over-calling, not to be a clinical-genomics product.

Clinical genomics, report review, UI, and domain-specific judgment rubrics belong in a downstream workbench. If that
workbench cannot express a workflow as declared resources -> SQL/materialization -> optional compute -> recorded run
-> observations/links -> CAS artifacts -> replay/export, then core has a real gap. If it can, keep the behavior
downstream.

## Consumer-Pulled Lanes

These are not current core implementation requests. They become core only when a concrete consumer repeats the shape
and cannot express it through existing primitives:

- runtime interrupt/abort adapters over `recordHostEvent`;
- scheduler-native backends for SLURM, `targets`, `mirai`, `nanonext`, Modal, or worker pools;
- scoped relation/resource visibility narrower than the injected `SqlConn`;
- SemanticSQL relation-graph policy, trust reconciliation, and thin ontology-ingest adapters;
- training-corpus labels, redaction policy, export contracts, or typed Parquet schemas;
- renderer-specific review packets, notebook/report schemas, or UI report models;
- SDK helpers beyond current exports;
- workbench package abstractions after a downstream app proves repeated shape;
- external-tool robustness for `rv`, OpenTargets, ChEMBL, Monarch DuckDB, Nextflow, and similar systems;
- shared node identity normalization for BioBTree-style multi-source KGs;
- ducknng-fs / DuckTinyCC research.

The refinement ledger in [`refinments.md`](./refinments.md) tracks these without treating them as active substrate
work.

## Harness-Adaptation Doctrine

Safe adaptation is declarative, validated, reversible, recorded, and activated at an explicit host boundary.

Allowed path:

1. propose a manifest, operation spec, resolver adapter, extension, or skill;
2. validate it with the relevant schema and fail-closed guards;
3. test it against fixtures or live-gated integration;
4. record the candidate, result, and decision in observations;
5. activate at a reload/install/CLI boundary;
6. roll back by appending a new temporal state, never by rewriting history.

Forbidden path:

- editing core files in place as an agent adaptation;
- monkey-patching tools;
- silently changing execution behavior;
- hiding network, filesystem, process, credential, or tenant policy in prompt text;
- promoting a biomedical fact without declared data, deterministic computation, or recorded judgment.

Every new surface must fit this doctrine before it ships.
