# Ontologies and knowledge graphs

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
