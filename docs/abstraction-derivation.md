# Deriving the abstractions

The core should stay small enough that new domains can be expressed as data, tool specs, and study notes instead of new framework code.

## Lessons from curation systems

Metadata curation shows a useful determinism gradient:

- deterministic spine: lookup, archive, acquire, table loading, ontology lookup, diff/QC, report
- judgment joints: table classification, column mapping, candidate disambiguation

The core abstraction is therefore not "a curation skill". It is:

```text
schema + source tables + ontology store + typed judgment request + deterministic validator
```

The model can propose mappings or choose among real candidates, but identifiers and ontology CURIEs should come from deterministic tools.

## Lessons from research-intelligence systems

Research-intelligence data argues for:

- raw/bronze capture of expensive upstream data
- curated/silver projections derived cheaply from raw
- dimension entities for joins and rollups
- full-text search in DuckDB where it is enough
- read-only NL→SQL guarded below the model
- lake-style shared substrate when many projects consume the same canonical facts

The core abstraction is therefore not "an OpenAlex tool" or "a dashboard tool". It is:

```text
source -> raw resource -> curated table/view -> dimension graph -> guarded SQL surface
```

## Lessons from machine studying

"Study" here is the [machine studying](https://jacobxli.com/blog/2026/machine-studying/) sense — an
agent deliberately learning a corpus and retaining what it learns — **not** a biomedical study, trial,
cohort, or GWAS. The repo keeps the term internally (`StudyNote`, `studyNote*`); user-facing surfaces
should prefer "notes" to avoid that domain collision.

Studying is different from skill sprawl. A skill is a reusable playbook. A study note is developing expertise:

- corpus map
- cheatsheet
- concept map
- failure case
- expertise probe
- rubric
- worked example
- skill draft

The agent should study a corpus, index what it learns, and only promote stable workflows into skills.

## Load-bearing primitives

The minimum primitives that make many bio workflows simple are:

1. `BioToolSpec` — provider-agnostic executable contract.
2. `ResourceHandle` / resolver spec — content-addressed or virtual resource access.
3. Ontology tables — terms, edges, mappings, term sets.
4. Knowledge graph tables — nodes, edges, observations, artifacts, trust blocks.
5. DuckDB substrate — stable SQL views over files, extensions, parquet/lake tables, and catalogs.
6. Study notes — indexed, mutable expertise memory distinct from skills.
7. Extension registry — single-user contributions of tool specs, resource resolvers, and skill drafts.
8. Skill writer — promote a stabilized workflow into a project-local Pi skill and reload.

Everything else should be an adapter or a registry entry until proven otherwise.
