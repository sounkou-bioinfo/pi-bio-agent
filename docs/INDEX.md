<!-- generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs; do not edit by hand -->
# Docs index

## Guide

- [User guide — write a manifest, run an operation](guide.md) — Practical walkthrough: declare resources/operations as a manifest and run them; resolvers, ordinal scales, grounding, runs, and network. _(guide, manifest, operations, usage)_

## Reference

- [Conceptual architecture](design.md) — The canonical conceptual model for core boundaries, execution, evidence, memory, and host composition. _(architecture, contracts, execution, evidence, memory)_
- [Concurrent memory — running the store over a ducknng server](concurrency.md) — Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store. _(memory, store, concurrency, ducknng, sharing)_
- [Domain model](domain-model.md) — Read before adding any core type or manifest — kernel slots, resources/CAS/resolvers, temporality, manifests, and execution backends. _(domain-model, resources, resolvers, temporality, manifests, execution-backends)_
- [DuckDB substrate](duckdb-substrate.md) — Read before using DuckDB tables, extensions, or SQL surfaces over bio data. _(duckdb, sql, extensions, substrate)_
- [Lineage and adjacent systems](lineage.md) — The concrete systems and results that shaped the substrate, including the limits of each comparison. _(lineage, metacurator, machine-studying, fugu, rlm, semanticsql)_
- [Memory and knowledge in one temporal ledger](memory-and-knowledge-unification.md) — Implemented mechanics for memory revisions, typed links, observations, graph projection, and session ingestion. _(memory, observations, temporal, graph, sessions)_
- [Ontologies and knowledge graphs](ontology-and-knowledge-graphs.md) — Read before modeling ontologies, KG nodes/edges, or the graph-as-substrate bet. _(ontology, knowledge-graph, graph-bet, provenance)_
- [Resources and resolvers](resources-and-tool-specs.md) — Read before defining resources, resolvers, or operation contracts. _(resources, cas, resolvers, operation-spec)_
- [Roadmap and success contract](roadmap.md) — Current substrate closure, falsifiable success criteria, proof levels, and consumer-pulled next work. _(roadmap, testing, success, applications)_

## Worklog

- [Refinements](refinments.md) — Concrete sharp edges and consumer-pulled work that remain after core substrate closure. _(refinements, open-issues, worklog)_
