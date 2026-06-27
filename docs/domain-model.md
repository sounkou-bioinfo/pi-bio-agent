# Domain model

`pi-bio-agent` is a substrate for agentic bioinformatics, not a pile of canned scripts.

The core abstraction is:

```text
question -> context -> BioToolSpec/resource -> scoped execution -> facts/artifacts/graph delta -> explanation
```

The agent can reason over the BioToolSpec registry, resource resolvers, study notes, and live context. It should not need a bespoke skill for every question.

## Primitive families

| Family | Purpose | SQL-friendly representation |
|---|---|---|
| Source | Where data can be read from | `bio_sources`, connector manifests, attached DuckDB files |
| Artifact | Concrete input/output/cache/reference | `bio_artifacts` |
| Interval | Genomic/span coordinate | `bio_intervals` |
| Variant | Allele-level key | `bio_variants` |
| Feature | Gene/transcript/exon/regulatory feature | `bio_features` |
| Ontology term | Stable meaning | `ontology_terms` |
| Tree | Hierarchy/taxonomy/phylogeny | node table + edge table |
| Matrix | Expression/genotype/assay tensor slice | matrix coordinate table or extension-backed view |
| Observation | A sourced fact | `bio_observations` |
| Graph edge | Relationships and provenance | `bio_edges` |
| BioToolSpec | Executable domain affordance | provider-agnostic tool contract with typed inputs/outputs/effects/surfaces |

## The key design move

Most bio questions are not skills. They are compositions of:

- source discovery
- schema/shape introspection
- ontology resolution
- graph or table query
- optional deterministic computation
- provenance-preserving explanation

A skill is only appropriate when a workflow has stabilized enough to be worth saving as reusable instructions.

## Context contract

A model context should carry compact indexes, not dumped data:

- selected subject/dataset/cohort
- available sources and artifacts
- graph shape: node families, edge predicates, populated JSON keys
- ontology bundles and term sets
- available BioToolSpec contracts, resource resolvers, and DuckDB extensions
- unresolved assumptions and defaults

For large data, the agent should query through DuckDB or a scoped graph sandbox rather than loading rows into the prompt.

## Extension registry

Extensions contribute data, not framework branches:

- `BioToolSpec` entries
- resource resolver specs
- optional skill drafts

This repo assumes a personal/single-user Pi setup. Policy-heavy deployments can wrap adapters, but the core contracts remain policy-neutral.
