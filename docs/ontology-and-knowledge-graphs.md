---
type: Reference
title: Ontologies and knowledge graphs
description: "Read before modeling ontologies, KG nodes/edges, or the graph-as-substrate bet."
tags: [ontology, knowledge-graph, graph-bet, provenance]
---

# Ontologies and knowledge graphs

## The graph bet (the domain wager)

The deepest architectural choice in `pi-bio-agent` is not the memory/study layer: it is the bet that
**agentic biomedicine is best served by one typed-graph substrate**, queried as SQL over DuckDB, rather
than by organizing the system primarily around per-source API clients, a vector store, or prose context.
Per-source clients and operation specs remain essential as *adapters and ingestion surfaces*: the bet
is that they feed the graph, not that they become the organizing substrate. Biomedical knowledge is natively
graph-shaped: ontologies (`term —is_a→ term`), entities and relations (`variant —in→ gene
—associated_with→ disease`), evidence (`claim —supports→ entity`), provenance and lineage
(`fact —derived_from→ fact`), and reanalysis (as-of edges). The domain is graph-first, with tabular and
document views over it, not the other way round.

So everything that can be a fact, a concept, or a relationship lives in the **same** append-only
`bio_observations` log (plus ontology tables), with trust/provenance fields on every row; edge-like rows
project into the materialized `bio_edges_as_of` closure that graph walks run over. Ontology terms, KG facts,
observations, artifacts, and the agent's own study notes (`memory:<slug>` subjects, note-links as edge observations), are all one graph, queried the same way. This is *why* `remember` writes note-links as edge
observations (projected into `bio_edges_as_of`) instead of a separate notes index: **memory is a subject
family in the one log, not a parallel system.** The "memory and KG stop being two systems" point in
[`memory-and-knowledge-unification.md`](./memory-and-knowledge-unification.md) is the local symptom of
this global bet; the study/[machine-studying](./machine-studying-lineage.md) angle is one consumer of
the substrate, not its foundation.

**The harness records authored declarations in the same graph, not its running code.** When a run has a supplied
ledger, `recordManifestDeclarations` records manifest, resolver, resource, operation, and term-set nodes. It records
`provides`, `resolved_by`, and `requires` edges, then links the run with `uses_manifest`, `uses_resource`, and, for a
named operation, `executes_operation`. Artifact production and tool-call attribution use their existing ordinary
edges. Host capability receipts remain digest references on the run until a consumer needs separate capability
nodes; installed skills and extensions are not currently projected automatically. Executable code remains in
package files and CAS artifacts. See [declaration-graph.ts](../src/hosts/declaration-graph.ts) and
[declaration-graph.test.ts](../test/declaration-graph.test.ts).

It is a *bet*, not a theorem, and the design hedges it honestly: not all bio data is usefully
graph-shaped (dense matrices, sequences, large tables stay tabular/extension-backed or in CAS; the graph
holds hot structured facts + indexes, not raw bytes), a single graph store can rot into a god-store, and
"graph-as-SQL over DuckDB" assumes the join/scan performance holds at scale. Those hedges, CAS, virtual resources, DuckDB extensions, no-FK dangling tolerance, are what keep the bet from becoming a monolith.

## Ontologies

Model ontologies as ordinary graph data. The minimum contract is:

```sql
ontology_terms(system, id, label, definition, synonyms JSON, obsolete BOOLEAN, source, metadata JSON)
ontology_edges(subject_system, subject_id, predicate, object_system, object_id, source, evidence JSON)
ontology_mappings(from_system, from_id, predicate, to_system, to_id, confidence, source JSON)
term_sets(term_set_id, label, description, provenance JSON)
term_set_members(term_set_id, system, id, include_descendants BOOLEAN, predicates JSON)
```

This supports:

- synonym lookup
- ancestor/descendant traversal
- cross-ontology xrefs
- local-code to ontology mappings
- reusable term sets
- explicit version/provenance

The important principle: labels are not semantics. A domain phrase becomes useful only when bound to an ontology term set, predicate, threshold, source version, and provenance.

### Semantic SQL to DuckDB

The direct lineage is the [INCAtools Semantic SQL](https://github.com/INCATools/semantic-sql) source spec.
[op2workshop](https://github.com/vjcitn/op2workshop) / ontoProc2 is the discovery route that made the fit obvious:
biomedical ontologies can be distributed as common SQLite artifacts, connected with
`semsql_connect(ontology="mondo")`, searched for labels, inspected by CURIE, traversed for descendants, and then
joined back to GWAS phenotype interpretation. The schema we port, however, is the source LinkML spec in
`INCATools/semantic-sql`, not the workshop package.

Semantic SQL's source of truth is LinkML. It compiles to SQL base tables and views: `statements` for RDF triples
(`subject`, `predicate`, `object`, `value`, `datatype`, `language`), `prefix` for CURIE expansion, and
`entailed_edge` for relation-graph closure. Tables like `edge`, `rdfs_label_statement`, and other
domain-specific statement tables are generated views over those base tables.

`pi-bio-agent` ports that source shape into DuckDB rather than wrapping it as a special ontology client. SemanticSQL
artifacts enter DuckDB staging tables, generated views feed `bio_edges` / `entailed_edge`, and manifests query those
relations with ordinary SQL.

SQLite is an interchange artifact; DuckDB is the query substrate. The exercised path maps Semantic SQL
`edge(subject,predicate,object)` into `bio_edges(from_id,predicate,to_id)`, keeps term metadata `statements` in a
DuckDB table for grounding, and either recomputes closure with our `entailed_edge` materializer or copies a declared
upstream `entailed_edge` artifact into the same target shape. The executable profile path is symmetric:
`materializeGraphProjectionProfile` applies a `GraphProjectionProfile` to staged ontology edge tables, declared
upstream closure artifacts, and the internal `bio_edges_as_of` observation graph.
The canonical edge-column contract for KGX and SemanticSQL-shaped tables is just `subject`, `predicate`, `object`,
optionally `attrs` and `trust`; KGX qualifiers, evidence, and knowledge sources stay on asserted-edge metadata, not
closure rows. An ordinary `GraphProjectionProfile` maps those columns into `bio_edges`. The Monarch KG HTTP example
proves that a real downloadable KGX TSV can enter through `duckdb.sql_materialize` plus DuckDB `httpfs`, then project
into `bio_edges` with no Monarch-specific resolver. A richer
resolver can also project CURIEs, labels, definitions, synonyms, predicates, xrefs, obsolete flags, source ontology,
and version/provenance into the stable `ontology_terms`, `ontology_edges`, and `ontology_mappings` views above. This
keeps ontology lookup, descendant expansion, term-set materialization, GWAS phenotype joins, and agent-authored SQL in
one execution model. Do not add a MONDO/HPO/OLS-specific helper when a resolver can materialize the Semantic SQL schema
into the generic graph contract.

## Knowledge graph

The KG is a typed graph over facts, artifacts, concepts, and evidence. A simple SQL contract is:

```sql
-- THE store: one APPEND-ONLY TEMPORAL statement log (BUILT — src/duckdb/observations.ts). There is no separate
-- authored node table — a node is just an id referenced by rows; re-assertion is a new row, never a mutation.
-- statement_key = the state SLOT a later row supersedes; a row is edge-like (object_id) or scalar (value_json):
bio_observations(observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at, valid_from, valid_to, source, digest, attrs JSON, trust JSON)
bio_artifacts(node_id, path, format, role, digest, attrs JSON)
-- the COMPILED navigation graph, materialized by materializeBioEdgesAsOf(conn, t): edge-like observations,
-- latest-per-statement_key as of t, over which the entailed_edge closure runs.
bio_edges_as_of(from_id, to_id, predicate, attrs JSON, trust JSON)
```

`observationsAsOf(t)` returns the latest row per `statement_key` (recorded_at ≤ t, valid interval contains t);
edge-like observations project into `bio_edges_as_of(t)` over which the same `entailed_edge` closure runs. A
measured scalar (a clinical value with `code_system`/`unit`) is just an observation whose `value_json` carries
`{ code_system, code_id, name, value, unit }`: the general form subsumes the earlier measurement-specific shape.

### Node families

- subject, sample, cohort
- artifact, source, cache
- interval, variant, feature, matrix, tree
- ontology_term, concept
- observation, evidence, analysis
- memory/skill/capability when modeling agent state

### Edge predicates

- structural: `has_sample`, `contains`, `overlaps`
- semantic: `about`, `annotated_as`, `maps_to`
- provenance: `derived_from`, `extracted_from`, `supports`, `contradicts`
- temporal/versioning: `supersedes`

## Trust and provenance

Every fact-like node or edge should be able to answer:

- where did this come from?
- which version or date?
- which command, SQL query, or tool created it?
- is it measured evidence, imported data, computed result, attestation, or model-authored insight?
- what confidence or quality flags apply?

## Graph-as-SQL

For counts, joins, trends, provenance, and lineage, use one scoped read-only SQL query over the graph contract. This avoids context bloat and keeps the agent honest: the answer is computed from exposed facts, not inferred from prose.

This is also the graph-inference bet behind the repo. The ICLR 2026 paper
["Actions Speak Louder than Prompts"](https://arxiv.org/abs/2509.18487) found that graph-as-code outperforms
prompt serialization on text-rich graph tasks, especially when long features or high-degree neighborhoods exhaust
the context budget. In `pi-bio-agent`, graph-as-code should normally mean graph-as-SQL: the model writes a bounded
query over `bio_edges_as_of`, `entailed_edge`, ontology tables, resolver-materialized resources, run observations,
or memory notes. The graph remains outside the prompt, and the executable action is small, inspectable, and
receipted.

First-answer latency is another graph-projection problem. The PVLDB 2026 LFS work on first-sight summaries
constructs compact subgraphs from query logs so exploratory SPARQL queries can return early exact answers without
scanning the full KG. Locally, that pattern should be expressed as a workload-derived projection profile over
`bio_edges_as_of`, `entailed_edge`, and resolver-materialized KG tables: sampled answer-supporting edges become
ordinary graph rows with receipts, budgets are materialized-view policy, and fallback to the full source remains an
explicit host choice. It is not a prompt summary and not a new per-question skill.

Do not collapse typed predicates into "neighbors" unless the operation really only needs adjacency. A biomedical
edge may encode subclass, part-of, evidence, support, contradiction, derivation, activation, containment, or
temporal supersession. Keeping those predicates queryable is what lets an agent adapt its reliance between
structure, features, labels, evidence, and provenance instead of assuming one graph homophily pattern.

## Concepts vs ontologies

Concept nodes are local handles for user-facing themes. Ontology terms are external controlled vocabulary identifiers. Connect them with explicit `maps_to` or `about` edges instead of pretending a local label is a global ontology identifier.
