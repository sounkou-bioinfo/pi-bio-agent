---
type: Reference
title: Deriving the abstractions
description: "Read to see why the core primitives exist and where machine-studying fits."
tags: [abstractions, primitives, machine-studying]
---

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
should prefer "notes" to avoid that domain collision. See
[`machine-studying-lineage.md`](./machine-studying-lineage.md) for the distilled source notes and
implications for this package.

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

## External convergence: ClawBio, metacurator, cu-research-intelligence, biomedical-agent-kg

Four independently-built systems arrive at the same substrate from different directions. We cite them
to justify *patterns*, not to import their nouns.

- **[ClawBio](https://github.com/ClawBio/ClawBio)** — ~80 per-question skills (a 12–26 KB program each).
  Factors into shared format resolvers + declared SQL operations + term sets + one generic runner. Its
  `rhi_01` bench case is our flagship's ground truth.
- **[metacurator](https://github.com/seandavi/metacurator)** — a **deterministic spine + a narrow typed
  judgment boundary**: the LLM may only emit typed objects that deterministic code validates, and
  `disambiguate` may return only one of the provided grounded CURIEs or `None`. That is term-set
  membership + fail-closed + abstention — our resolver discipline with a model behind one impl. The
  judgment boundary is a *manifest-level pattern*, not a core noun.
- **[cu-research-intelligence](https://github.com/seandavi/cu-research-intelligence)** — OpenAlex →
  Parquet → DuckDB with per-partition watermarks and a storage backend that swaps local→R2 with no code
  change. Reinforces **CAS/raw→curated layering**, snapshot temporality, and DuckDB as the query layer.
- **[biomedical-agent-kg](https://github.com/seandavi/biomedical-agent-kg)** — "nodes are what you
  traverse *through*; attributes are what you filter *on*", fully generated, "fix the generator, not the
  record", provenance on every expensive edge. That is our typed KG + generated-not-prose + rules-as-data.

The shared spine across all four — **DuckDB as query/index substrate · generated/spec-first contracts ·
provenance/receipts · fail-closed resolvers over opaque stable ids · deterministic spine + typed judgment ·
CAS/raw→curated layering** — is evidence the primitives are discovered, not invented.

## Load-bearing primitives

The minimum primitives that make many bio workflows simple are:

1. `BioToolSpec` — provider-agnostic executable contract.
2. `BioResolverSpec` + `VirtualResourceSpec` — declared resources resolved through a validated registry
   (`resolveResource`, registry-stamped `ResolutionReceipt`s) into content-addressed or virtual handles.
3. Ontology tables — terms, edges, mappings, term sets.
4. Knowledge graph tables — nodes, edges, observations, artifacts, trust blocks.
5. DuckDB substrate — stable SQL views over files, extensions, parquet/lake tables, and catalogs.
6. Study notes — indexed, mutable expertise memory distinct from skills.
7. `BioManifest` registry — serializable spec declarations bound to runtime impls; the boundary
   where packs register resolvers, resources, views, term sets, and operations.
8. Skill writer — promote a stabilized workflow into a project-local Pi skill and reload.

Everything else should be an adapter or a registry entry until proven otherwise.
