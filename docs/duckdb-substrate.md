---
type: Reference
title: DuckDB substrate
description: "Read before using DuckDB tables, extensions, or SQL surfaces over bio data."
tags: [duckdb, sql, extensions, substrate]
---

# DuckDB substrate

DuckDB is the default tabular and graph substrate for `pi-bio-agent`.

## Why DuckDB

- SQL gives the agent a compact, inspectable execution language.
- Table functions expose bio formats without one-off parsers.
- Query plans, projection pushdown, filters, joins, and indexes reduce context pressure.
- Code/SQL over graph tables is the preferred LLM-graph interaction mode; large graph neighborhoods should be
  queried, not serialized into prompts.
- Results can be surfaced to R, Python, CLI, Pi tools, or future services.

## Useful extensions

| Extension | Use |
|---|---|
| `duckhts` | VCF/BCF, BAM/CRAM/SAM, FASTA/FASTQ, BED, GTF/GFF, tabix, BGZF, sequence UDFs, selected bcftools-style kernels |
| `plinking_duck` | PLINK genotypes, allele frequency, missingness, LD, PRS, PCA, GWAS-style analytics |
| `anndata` | `.h5ad` single-cell obs/var/X/layers/embeddings |
| `duckdb_zarr` | Zarr groups, arrays, chunks, dense cell scans |
| `fts` | local search over catalogs, ontology labels/synonyms, documents, capability descriptions |
| `httpfs` | remote HTTPS/S3 data only with explicit policy and credentials |

## Stable views

Backends should expose stable views even when the physical source is an extension call, parquet file, attached DuckDB database, or shell-produced staging file.
For ontology sources, this means port the canonical INCAtools/Semantic SQL LinkML schema shape, not an
application-specific wrapper: `statements`, `prefix`, `entailed_edge`, plus generated views such as `edge`.
SQLite Semantic SQL databases are interchange artifacts; DuckDB remains the joined/queryable substrate for
agent-authored SQL and recursive closure.
`materializeSemanticSqlSourceViews` is the current library helper for staged `statements`: it creates the generated
RDF/RDFS statement views, relation-graph `edge`, RO `part_of` / `has_part` edge filters, subgraph inspection views,
ChEBI conjugate-acid/base and charge views, label, definition, synonym, mapping, deprecated-node, OBO problem,
ontology-status, and term views that a manifest or `GraphProjectionProfile` can consume, with optional IRI-to-CURIE
canonicalization through a staged
`prefix(prefix, base)` table. A staged `textual_transformation(subject, predicate, value)` table adds the
SemanticSQL NLP inspection layer: `processed_statement`, and with a prefix table, `subject_prefix` plus `match`.
An optional staged `term_association(id, subject, predicate, object, evidence_type, publication, source)` source
table can be exposed as a canonical association view, then projected into `bio_edges` with the same graph profile
shape. `targetSchema` scopes generated default views for multi-ontology staging, so separate source artifacts can
materialize side by side and be joined as ordinary DuckDB relations.
The generated `edge_with_metadata` view adds graph-ready `attrs`/`trust` JSON to generated edges from matching OWL
axiom annotations, evidence xrefs, and OBO problem rows.
When a source ships a precomputed SemanticSQL/relation-graph `entailed_edge`, `materializeGraphProjectionProfile`
can copy that declared artifact into the same closure-table shape; `materializeSemanticSqlSourceViews` can also use
a staged `entailed_edge(subject, predicate, object)` table to expose closure-backed ancestor/descendant, subclass,
type, cycle, node-pair overlap, and taxon-constraint views, including most-specific inferred in-taxon. Otherwise the
local CTE closure remains the default.

Suggested stable views:

```sql
bio_sources
bio_artifacts
bio_observations       -- THE append-only temporal log (nodes are just ids referenced by rows)
bio_edges_as_of        -- the compiled navigation graph, materialized from edge-like observations as of t
bio_intervals
bio_variants
bio_features
bio_matrices
ontology_terms
ontology_edges
ontology_mappings
```

## Policy

1. Prefer a DuckDB extension or table function before writing a parser.
2. Prefer a scoped read-only SQL query before dumping data into context.
3. Do not hide semantics in filenames or JSON blobs when a typed edge/table should exist.
4. Always record assembly and coordinate system for genomic spans.
5. Always preserve provenance for derived facts.
6. For graph inference, prefer graph-as-SQL/code over graph-as-prompt. Prompt text is the instruction channel, not
   the graph transport.
