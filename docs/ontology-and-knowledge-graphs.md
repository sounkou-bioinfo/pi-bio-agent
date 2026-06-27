# Ontologies and knowledge graphs

## The graph bet (the domain wager)

The deepest architectural choice in `pi-bio-agent` is not the memory/study layer — it is the bet that
**agentic biomedicine is best served by one typed-graph substrate**, queried as SQL over DuckDB, rather
than by organizing the system primarily around per-source API clients, a vector store, or prose context.
Per-source clients and operation specs remain essential as *adapters and ingestion surfaces* — the bet
is that they feed the graph, not that they become the organizing substrate. Biomedical knowledge is natively
graph-shaped: ontologies (`term —is_a→ term`), entities and relations (`variant —in→ gene
—associated_with→ disease`), evidence (`claim —supports→ entity`), provenance and lineage
(`fact —derived_from→ fact`), and reanalysis (as-of edges). The domain is graph-first, with tabular and
document views over it — not the other way round.

So everything that can be a fact, a concept, or a relationship lives in the **same** `bio_nodes`/
`bio_edges` (plus ontology tables), with trust/provenance on every node and edge. Ontology terms, KG
facts, observations, artifacts — and the agent's own study notes (`memory:<slug>` nodes, note-links as
edges) — are all one graph, queried the same way. This is *why* `studyNoteGraph` projects notes into
`bio_edges` instead of a separate notes index: **memory is a node family in the one graph, not a
parallel system.** The "memory and KG stop being two systems" point in
[`memory-and-knowledge-unification.md`](./memory-and-knowledge-unification.md) is the local symptom of
this global bet; the study/[machine-studying](./machine-studying-lineage.md) angle is one consumer of
the substrate, not its foundation.

It is a *bet*, not a theorem, and the design hedges it honestly: not all bio data is usefully
graph-shaped (dense matrices, sequences, large tables stay tabular/extension-backed or in CAS; the graph
holds hot structured facts + indexes, not raw bytes), a single graph store can rot into a god-store, and
"graph-as-SQL over DuckDB" assumes the join/scan performance holds at scale. Those hedges — CAS, virtual
resources, DuckDB extensions, no-FK dangling tolerance — are what keep the bet from becoming a monolith.

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

## Knowledge graph

The KG is a typed graph over facts, artifacts, concepts, and evidence. A simple SQL contract is:

```sql
bio_nodes(node_id, family, type, label, description, attrs JSON, trust JSON)
bio_edges(from_id, to_id, predicate, attrs JSON, trust JSON)
bio_observations(node_id, subject_id, observed_at, code_system, code_id, name, value, unit, attrs JSON, trust JSON)
bio_artifacts(node_id, path, format, role, digest, attrs JSON)
```

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

## Concepts vs ontologies

Concept nodes are local handles for user-facing themes. Ontology terms are external controlled vocabulary identifiers. Connect them with explicit `maps_to` or `about` edges instead of pretending a local label is a global ontology identifier.
