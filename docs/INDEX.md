<!-- generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs; do not edit by hand -->
# Docs index

## Guide

- [User guide — write a manifest, run an operation](guide.md) — Practical walkthrough: declare resources/operations as a manifest and run them; resolvers, ordinal scales, grounding, runs, and network. _(guide, manifest, operations, usage)_

## Proposal

- [Bring-it-home plan — core substrate closure](bring-it-home-plan.md) — Core-library closure ledger after the workbench split: what is closed in pi-bio-agent, what proves it, and what remains outside core. _(roadmap, substrate, host-events, jobs, graph-projection, artifacts, corpus, ducknng)_
- [Clinical-genomics application pattern on pi-bio-agent](clinical-genomics-application.md) — A downstream application pattern that consumes pi-bio-agent as a library: staged, deterministic-first variant analysis (case structuring, annotation, HPO, prioritization, scoring, ACMG, family-aware interpretation) with recorded-and-gated judgment. Read before scoping clinical-genomics applications or papers. _(flagship, application, clinical-genomics, product, reproducibility)_
- [Memory and knowledge unification](memory-and-knowledge-unification.md) — The temporal substrate unification: memory, facts, jobs, store-logged runs, and agent session traces are one append-only bio_observations store (Datomic-style, as-of/history/tombstone; runs and sessions fold in when the host supplies the store/CAS hooks). Read before changing memory, session ingestion, or graph projection. _(memory, temporal, bio-observations, unification)_

## Reference

- [Concurrent memory — running the store over a ducknng server](concurrency.md) — Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store. _(memory, store, concurrency, ducknng, sharing)_
- [Deriving the abstractions](abstraction-derivation.md) — Read to see why the core primitives exist and where machine-studying fits. _(abstractions, primitives, machine-studying)_
- [Design notes](design.md) — Read before changing core contracts, adapters, storage, skills, or the harness-adaptation surface. _(architecture, contracts, adapters, harness)_
- [Domain model](domain-model.md) — Read before adding any core type or manifest — kernel slots, resources/CAS/resolvers, temporality, manifests, and execution backends. _(domain-model, resources, resolvers, temporality, manifests, execution-backends)_
- [DuckDB substrate](duckdb-substrate.md) — Read before using DuckDB tables, extensions, or SQL surfaces over bio data. _(duckdb, sql, extensions, substrate)_
- [Machine studying lineage](machine-studying-lineage.md) — Read to understand what 'study' means here (machine studying) and how it lands on graphs. _(machine-studying, study-notes, graph-bet, lineage)_
- [Ontologies and knowledge graphs](ontology-and-knowledge-graphs.md) — Read before modeling ontologies, KG nodes/edges, or the graph-as-substrate bet. _(ontology, knowledge-graph, graph-bet, provenance)_
- [Resources and resolvers](resources-and-tool-specs.md) — Read before defining resources, resolvers, or operation contracts. _(resources, cas, resolvers, operation-spec)_
- [Roadmap, success, and testing contract](roadmap.md) — Read before planning roadmap, success metrics, tests, or flagship work; current core closure and consumer-pulled lanes. _(roadmap, testing, success, flagship)_
- [What the substrate closes over](closes-over.md) — How the manifest/SQL/DuckDB substrate subsumes agent topologies, learned orchestration (Fugu), and REPL-over-context (RLM) — with references. _(topologies, fugu, rlm, machine-studying, positioning)_

## Worklog

- [Refinements](refinments.md) — Live cleanup targets that still need concrete consumer pressure before they become core work. _(refinements, open-issues, worklog)_
