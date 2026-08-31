<!-- generated from docs/*.md frontmatter by scripts/generate-docs-index.mjs; do not edit by hand -->
# Docs index

## Guide

- [User guide — write a manifest, run an operation](guide.md) — Practical walkthrough: declare resources/operations as a manifest and run them; resolvers, ordinal scales, grounding, runs, and network. _(guide, manifest, operations, usage)_

## Reference

- [Conceptual architecture](design.md) — The canonical system model for agent-authored programs, durable control, execution, evidence, memory, and host composition. _(architecture, agents, control-plane, execution, evidence, memory)_
- [Concurrent state and durable control plane](concurrency.md) — Read before sharing memory, jobs, attempts, or resource pools across processes, agents, or machines. _(memory, jobs, control-plane, concurrency, ducknng, sqlite, postgres, quack)_
- [Domain model](domain-model.md) — Read before adding any core type or manifest — kernel slots, resources/CAS/resolvers, temporality, manifests, and execution backends. _(domain-model, resources, resolvers, temporality, manifests, execution-backends)_
- [DuckDB scientific substrate](duckdb-substrate.md) — Read before using DuckDB tables, extensions, attached control stores, or SQL surfaces over scientific data. _(duckdb, sql, extensions, substrate, control-plane)_
- [Lineage and adjacent systems](lineage.md) — The concrete systems and results that shaped the substrate, including the limits of each comparison. _(lineage, metacurator, machine-studying, fugu, rlm, semanticsql)_
- [Memory and knowledge in one temporal ledger](memory-and-knowledge-unification.md) — Implemented mechanics for memory revisions, typed links, observations, graph projection, and session ingestion. _(memory, observations, temporal, graph, sessions)_
- [Ontologies and knowledge graphs](ontology-and-knowledge-graphs.md) — Read before modeling ontologies, KG nodes/edges, or the graph-as-substrate bet. _(ontology, knowledge-graph, graph-bet, provenance)_
- [Resources, capacity, and tool contracts](resources-and-tool-specs.md) — Read before defining scientific resources, resolvers, execution capacity, or agent-facing operation contracts. _(resources, capacity, cas, resolvers, operation-spec, agents)_
- [Roadmap and success contract](roadmap.md) — Current substrate closure, agent-native success criteria, proof levels, and consumer-pulled next work. _(roadmap, testing, agents, control-plane, applications)_

## Worklog

- [Refinements](refinments.md) — Concrete sharp edges and consumer-pulled work that remain after core substrate closure. _(refinements, open-issues, worklog, control-plane)_
