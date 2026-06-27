---
name: pi-bio-agent
description: "Guides design and use of pi-bio-agent abstractions: SQL-first bio primitives, ontology and knowledge-graph modeling, DuckDB extension substrates, capability discovery, and project-local skill authoring. Use when building agentic bio/genomics workflows over Pi."
---

# Pi Bio Agent

Use this skill when a bioinformatics task should be handled by composable primitives rather than a one-off scripted skill.

## Core stance

Do not turn every natural-language question into a bespoke hand-coded skill. First expose the substrate:

- typed sources and artifacts
- genomic intervals, variants, features, samples, cohorts, matrices, and trees
- ontologies as term/edge/mapping SQL graphs
- knowledge graphs as typed nodes and edges with provenance/trust
- DuckDB extension-backed readers and kernels
- capability contracts that tell the agent what can be composed
- project-local skills only when a reusable workflow emerges

The LLM routes, clarifies, writes SQL/tool calls, explains, and can author new skills. It is not the source of biomedical facts.

"Study notes" here are [machine studying](https://jacobxli.com/blog/2026/machine-studying/) artifacts — the agent's own indexed, hooked learning about a corpus/API/domain — not biomedical studies/trials/cohorts.

## Preferred workflow

1. Call `bio_describe_model` to inspect the model and SQL contracts.
2. Call `bio_list_tool_specs` before claiming a domain capability is missing.
3. Call `bio_list_resource_resolvers` when the task may reduce to content-addressed resources or HTTP request surfaces.
4. Call `bio_list_duckdb_extensions` to identify useful DuckDB substrates.
5. For ontology or graph work, model the question as a read-only SQL query over stable views.
6. If a workflow repeats, use `bio_create_skill` to write a project-local skill and then ask the user to run `/reload`.

## Ontology modeling

Represent ontologies as SQL-visible graph tables:

- `ontology_terms(system, id, label, definition, synonyms, obsolete, source, metadata)`
- `ontology_edges(subject_system, subject_id, predicate, object_system, object_id, source, evidence)`
- `ontology_mappings(from_system, from_id, predicate, to_system, to_id, confidence, source)`
- term sets for reusable predicates, such as a consequence class or phenotype class

Avoid scattering domain phrases through code. Treat them as named predicates with explicit provenance, thresholds, ontology bindings, and source versions.

## Knowledge graph modeling

Use typed nodes:

- subject/sample/cohort
- artifact/source/cache
- interval/variant/feature/matrix/tree
- ontology term/concept
- observation/evidence/analysis

Use typed edges:

- `about`
- `annotated_as`
- `overlaps`
- `contains`
- `derived_from`
- `extracted_from`
- `supersedes`
- `supports` / `contradicts`

Facts should carry trust/provenance blocks: source, version, command or SQL, digest, producer, confidence, and evidence class.

## Resource and request substrate

Model reusable resources explicitly:

- content-addressed handles for local/cached bytes
- references for files, object-store URIs, and database tables
- virtual handles for resources resolved by an adapter
- declarative HTTP request templates for tools that are fundamentally API calls

The core should know the contract, not the provider. A resolver spec says what request shape and output shape exist; an adapter decides how to inject credentials, enforce consent, fetch bytes, cache responses, and return a typed resource.

## DuckDB substrate

Prefer DuckDB table functions and extensions before custom parsers:

- `duckhts` for VCF/BCF/BAM/CRAM/FASTA/FASTQ/BED/GFF/GTF/tabix and genomics kernels
- `plinking_duck` for PLINK genotype data and cohort genetics analytics
- `anndata` for h5ad single-cell data
- `duckdb_zarr` for Zarr arrays
- `fts` for local catalog and ontology search
- `httpfs` only when remote access is explicitly allowed

## Skill authoring rule

Create a skill only after you have a stable reusable workflow. The skill should describe:

- when to use it
- required sources/artifacts
- exact ontology/predicate definitions
- SQL/tool steps
- provenance and output contract
- safety boundaries

Do not use skills to hide missing substrate. Improve the substrate first.
