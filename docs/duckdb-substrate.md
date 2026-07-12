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
- Source region/range pushdown selects work efficiently; it is not a substitute for explicit semantic predicates in
  the consuming SQL. Keep exact chromosome/coordinate filters in the query when the answer depends on that interval.
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

## Network is SQL plus an async lifecycle

`ducknng` is not merely a one-request HTTP table function. It is the DuckDB-native network and RPC substrate that
the host provisions and the manifest/SQL composes:

| Need | Existing surface | Use |
|---|---|---|
| One JSON/CSV/body response | `ducknng_ncurl_table` | Compose a literal or SQL-derived URL/body and materialize one response table. |
| Many request bodies | `ducknng_ncurl_aio` + `ducknng_ncurl_aio_collect` | Launch one request per batch row, drain any-ready results, and treat status/error as data. |
| Bounded retry/fanout | `pi-bio-agent` `ncurlFanout` | Cap in-flight waves, retry transport/429/5xx results, fail on permanent responses, and cancel/drop handles on abort. |
| One endpoint retry | `pi-bio-agent` `ncurlRetry` | Use the owned volatile DuckNNG scalar and its SQL recursive retry path when one request is repeated. |
| Credentialed HTTP | DuckNNG HTTP profiles | The host registers a scoped profile; SQL names only its non-secret id and receives a redacted receipt. |
| Client TLS | `ducknng_tls_config_from_pem` | Create a runtime TLS handle without assuming a CA file. `ducknng_self_signed_tls_config` is the in-memory development path. |

This is a closed-over proof, not a planned abstraction. The deterministic fanout test exercises transient failures,
permanent failures, and cancellation; the WGS example exercises real indexed VCF input, 200-allele VEP batches,
DuckNNG AIO fanout, response parsing, and SQL reduction. The connector manifests remain the simpler one-request
case. A workbench should reuse these primitives and keep only domain SQL (batch body shape, response normalization,
joins, and review policy). A new TypeScript HTTP client in an application is a regression against this design.

The host still owns egress, extension provisioning, TLS material, credentials, and rate policy. `LOAD ducknng`
fails closed when the extension is absent; it does not install or silently replace the transport. The library records
the declared source, host capability/profile receipt, run result, and retry/failure outcome where the host supplies
the run store and CAS.

Remote data is not limited to HTTP-shaped APIs. DuckDB's official MySQL and Postgres extensions can attach a
host-admitted foreign catalog read-only; `duckdb.sql_materialize` then queries it with ordinary SQL. The host owns
extension provisioning, egress, credentials, and `ATTACH`. The manifest records the remote database/release as a
declared source and contains only the source query. `examples/connectors/ensembl-mysql.json` exercises this against
the release-pinned Ensembl human core database. Do not add a source-specific resolver where a foreign catalog and
schema discovery already close the gap.

Foreign-catalog references are explicit ambient host inputs, not manifest resource outputs. Resource forcing follows
unqualified and `main`-qualified local tables while leaving a qualified relation such as `ensembl.gene` to the
host-attached catalog. Local schema probes use `pragma_table_info` rather than unscoped `information_schema` scans;
the latter can enumerate remote metadata after an attach. For selective MySQL queries, the host should enable
DuckDB's filter pushdown or use `mysql_query` when the complete join must execute on the remote server.

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
The generated `edge_by_superproperty` view expands direct generated `edge` rows through transitive
`rdfs:subPropertyOf` links while retaining `source_predicate`, so consumers can opt into relation-graph-style
property hierarchy behavior without changing base `edge` semantics.
When a source ships a precomputed SemanticSQL/relation-graph `entailed_edge`, `materializeGraphProjectionProfile`
can copy that declared artifact into the same closure-table shape; `materializeSemanticSqlSourceViews` can also use
a staged `entailed_edge(subject, predicate, object)` table to expose closure-backed ancestor/descendant, subclass,
type, cycle, node-pair overlap, and taxon-constraint views, including most-specific inferred in-taxon. Otherwise the
local CTE closure remains the default.
Closure tables are deliberately just reachability. Evidence, Biolink/KGX qualifiers, and source-specific weights stay
on asserted edge/source views and can be joined or carried by a consumer-specific support/path view when needed.

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
5. Treat file/extension range pushdown as an optimization and state exact interval semantics in SQL.
6. Always preserve provenance for derived facts.
7. For graph inference, prefer graph-as-SQL/code over graph-as-prompt. Prompt text is the instruction channel, not
   the graph transport.
