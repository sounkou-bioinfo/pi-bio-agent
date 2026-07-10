---
type: Reference
title: Deriving the abstractions
description: "Read to see why the core primitives exist and where machine-studying fits."
tags: [abstractions, primitives, machine-studying]
---

# Deriving the abstractions

The core should stay small enough that new domains can be expressed as data, tool specs, and study notes instead of new framework code.

## Reconciliation rule

When two local abstractions start describing the same motion, do not add an overlay primitive to make both true.
Reconcile them against concrete instances, then collapse the weaker boundary. The method is:

- list the real cases already in the repo;
- name what must survive across all of them;
- delete naming that leaks one implementation into the primitive;
- keep compatibility only when an external surface truly requires it.

This is how the compute/job split should be read. Local child-process execution, an NNG worker, a scheduler,
a stateful REPL, an Absurd-style task queue, and the current run replay queue all share the same lifecycle:
`submit -> status -> collect -> cancel`. The primitive is `AsyncRunner`; `ComputeRunner` is its compute
specialization, and the durable run queue is the replay/run specialization. The mutable queue/claim table is
coordination. Receipts, CAS objects, replay specs, result digests, and `bio_observations` are the evidence.

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

"Study" here is the [machine studying](https://jacobxli.com/blog/2026/machine-studying/) sense: an
agent deliberately learning a corpus and retaining what it learns, **not** a biomedical study, trial,
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

## External convergence: ClawBio, metacurator, op2workshop, cu-research-intelligence, biomedical-agent-kg

Independently-built systems arrive at the same substrate from different directions. We cite them
to justify *patterns*, not to import their nouns.

- **[ClawBio](https://github.com/ClawBio/ClawBio)**: ~80 per-question skills (a 12–26 KB program each).
  Factors into shared format resolvers + declared SQL operations + term sets + one generic runner. Its
  `rhi_01` bench case is our flagship's ground truth.
- **[metacurator](https://github.com/seandavi/metacurator)**: a **deterministic spine + a narrow typed
  judgment boundary** for publication metadata curation. Its mechanical stages (`resolve`, `archive`, `acquire`,
  `tables`, `dictionary`, `ground`, `diff`, `report`) sharpened our resolver/materialization/receipt pattern; its
  `judge` operations (`classify_tables`, `propose_mapping`, `disambiguate`) sharpened the typed judgment pattern.
  The LLM may only emit typed objects that deterministic code validates, `propose_mapping` rejects unknown schema
  fields, and `disambiguate` may return only a grounded candidate or `None`. Its grounding code first performs
  lookup, round-trip confirmation, branch checking, and obsolete-term handling. That is term-set membership +
  fail-closed + abstention: our resolver discipline with a model behind one impl. The reconciliation is the point:
  no metacurator-specific core primitive is needed.
- **[op2workshop](https://github.com/vjcitn/op2workshop)**: a Bioc2026 ontoProc2 workshop that exposed the
  **Semantic SQL as ontology substrate** bet from the R/Bioconductor side. Its useful role here is lineage and
  motivation: `semsql_connect(ontology="mondo")`, `search_labels`, `get_term_info`, and `get_descendants` show
  how CURIE lookup and closure become programmable and then reconnect to GWAS phenotype interpretation. But the
  schema we port is the canonical [INCATools Semantic SQL](https://github.com/INCATools/semantic-sql) LinkML
  source spec, not the workshop package. The load-bearing source tables are `statements`, `prefix`, and
  `entailed_edge`; `edge` and domain-specific statement tables are generated views. Locally, that closes over as
  Semantic SQL source schema -> DuckDB staging tables -> `bio_edges` + recursive `entailed_edge` views ->
  manifest SQL. The current tests prove direct statement/edge-table translation; richer adapters can additionally
  project term metadata into `ontology_terms`, `ontology_edges`, and `ontology_mappings`.
- **[cu-research-intelligence](https://github.com/seandavi/cu-research-intelligence)**. OpenAlex →
  Parquet → DuckDB with per-partition watermarks and a storage backend that swaps local→R2 with no code
  change. Reinforces **CAS/raw→curated layering**, snapshot temporality, and DuckDB as the query layer.
- **[biomedical-agent-kg](https://github.com/seandavi/biomedical-agent-kg)**: "nodes are what you
  traverse *through*; attributes are what you filter *on*", fully generated, "fix the generator, not the
  record", provenance on every expensive edge. That is our typed KG + generated-not-prose + rules-as-data.
- **[Actions Speak Louder than Prompts](https://arxiv.org/abs/2509.18487)**: a controlled ICLR 2026 graph-inference
  study showing that generated code over graph state is the strongest LLM interaction mode, especially when long
  text or high-degree neighborhoods exceed prompt budgets. That is the external benchmark version of our
  graph-as-SQL posture.

The shared spine across these systems, **DuckDB as query/index substrate · generated/spec-first contracts · source schemas ported into typed graph tables · graph-as-code/SQL over graph-as-prompt · provenance/receipts · fail-closed resolvers over opaque stable ids · deterministic spine + typed judgment · CAS/raw→curated layering**, is evidence the primitives are discovered, not invented.

## Load-bearing primitives

The minimum primitives that make many bio workflows simple are:

1. `BioManifest`, the program: a serializable bag of resources/resolvers/operations/termSets, bound to
   runtime impls by a host. Provider-agnostic; no executable code in the manifest itself.
2. `BioResolverSpec` + `VirtualResourceSpec`: declared resources resolved through a validated registry
   (`resolveResource`, registry-stamped `ResolutionReceipt`s) into content-addressed or virtual handles.
3. Ontology tables: terms, edges, mappings, term sets.
4. Knowledge graph: the append-only `bio_observations` log (edge-like + scalar rows; a node is just an id
   referenced by rows, never a separate authored node table), the compiled `bio_edges_as_of` closure, artifacts,
   and trust/provenance on every row.
5. DuckDB substrate: stable SQL over files, extensions, parquet/lake tables, and catalogs; `ducknng` extends
   it to network (`ncurl_table`), cross-process shared-DB RPC, and NNG topologies: network/multi-agent as SQL.
6. Memory notes: indexed expertise memory in the append-only `bio_observations` store (`memory:`
   namespace): append-only, as-of-recallable, tombstone-retractable, per-observation `author`: distinct from
   skills, not a mutable file store.
7. The registry (`createBioRegistry`): the runtime boundary where a manifest's serializable spec
   declarations are bound to executable impls (`bindResolverImpl`) and resolved (`resolveResource`).
8. Skill writer: promote a stabilized workflow into a project-local Pi skill and reload.

Everything else should be an adapter or a registry entry until proven otherwise.
