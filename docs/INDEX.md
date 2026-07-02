<!-- generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs; do not edit by hand -->
# Docs index

## Guide

- [User guide — write a manifest, run an operation](guide.md) — Practical walkthrough: declare resources/operations as a manifest and run them; resolvers, ordinal scales, grounding, runs, and network. _(guide, manifest, operations, usage)_

## Proposal

- [Memory and knowledge unification](memory-and-knowledge-unification.md) — The temporal memory unification: memory, facts, jobs, and runs are one append-only bio_observations store (Datomic-style, as-of/history/tombstone). Read before changing the memory store or its graph projection. _(memory, temporal, bio-observations, unification)_

## Reference

- [Concurrent memory — running the store over a ducknng/quack server](concurrency.md) — Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store. _(memory, store, concurrency, ducknng, sharing)_
- [Deriving the abstractions](abstraction-derivation.md) — Read to see why the core primitives exist and where machine-studying fits. _(abstractions, primitives, machine-studying)_
- [Design notes](design.md) — Read before changing core boundaries, adapters, storage, skills, or the harness-adaptation surface. _(architecture, boundaries, adapters, harness)_
- [Domain model](domain-model.md) — Read before adding any core type or manifest — kernel slots, resources/CAS/resolvers, temporality, manifests, and execution backends. _(domain-model, resources, resolvers, temporality, manifests, execution-backends)_
- [DuckDB substrate](duckdb-substrate.md) — Read before using DuckDB tables, extensions, or SQL surfaces over bio data. _(duckdb, sql, extensions, substrate)_
- [Machine studying lineage](machine-studying-lineage.md) — Read to understand what 'study' means here (machine studying) and how it lands on graphs. _(machine-studying, study-notes, graph-bet, lineage)_
- [Ontologies and knowledge graphs](ontology-and-knowledge-graphs.md) — Read before modeling ontologies, KG nodes/edges, or the graph-as-substrate bet. _(ontology, knowledge-graph, graph-bet, provenance)_
- [Resources and resolvers](resources-and-tool-specs.md) — Read before defining resources, resolvers, or operation contracts. _(resources, cas, resolvers, operation-spec)_
- [Roadmap, success, and testing contract](roadmap.md) — Read before planning roadmap, success metrics, tests, or flagship work. _(roadmap, testing, success, flagship)_
- [What the substrate closes over](closes-over.md) — How the manifest/SQL/DuckDB substrate subsumes agent topologies, learned orchestration (Fugu), and REPL-over-context (RLM) — with references. _(topologies, fugu, rlm, machine-studying, positioning)_

## Worklog

- [Refinements](refinments.md) — Open design issues and cleanup targets still to sharpen before abstractions harden. _(refinements, open-issues, worklog)_
