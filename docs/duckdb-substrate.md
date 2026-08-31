---
type: Reference
title: DuckDB scientific substrate
description: "Read before using DuckDB tables, extensions, attached control stores, or SQL surfaces over scientific data."
tags: [duckdb, sql, extensions, substrate, control-plane]
---

# DuckDB scientific substrate

DuckDB is the default tabular, graph, and inspection substrate for `pi-bio-agent`. It is not required to be the
transaction coordinator for every durable-control deployment.

## Plane separation

```text
scientific query plane                     durable control plane
DuckDB relations/extensions/graphs         jobs/attempts/leases/pools/allocations
optimized analytical reads                 short atomic state transitions
agent-authored SQL                         backend-specific transaction adapter
```

DuckDB may implement both planes in one process or behind a server-owned writer. SQLite or PostgreSQL may instead own
control state while DuckDB attaches or imports that state for joined inspection. A common SQL query surface does not
make backend locking and atomicity interchangeable.

This separation preserves the main benefit: the agent sees scientific data, execution state, evidence, and artifacts
as queryable relations without forcing one database engine to solve every workload.

## Why DuckDB

- SQL gives the agent a compact, inspectable execution language.
- Table functions expose bio formats without one-off parsers.
- Query plans, projection pushdown, filters, joins, and indexes reduce context pressure.
- Source region/range pushdown selects work efficiently; it is not a substitute for explicit semantic predicates in
  consuming SQL. Keep exact chromosome/coordinate filters in the query when the answer depends on that interval.
- Code/SQL over graph and control views is the preferred agent interaction mode; large neighborhoods and histories
  should be queried, not serialized into prompts.
- Results and stable control-store views can be surfaced to R, Python, CLI, Pi, MCP, browser, or future services.
- SQLite and PostgreSQL attachments allow one analytical workbench to join durable state with Parquet, CAS metadata,
  scientific tables, and reports.

## What DuckDB does not imply

- Read-only SQL validation is not a security sandbox.
- `ATTACH` is not a distributed transaction protocol.
- A DuckDB connection is not automatically safe for multiple independent writer processes.
- A common `SqlConn` shape does not prove same-slot compare-and-set or leased-claim semantics.
- Query federation does not authorize remote data, credentials, or cross-tenant visibility.
- A relation preview is not the complete scientific result unless it is explicitly labeled complete.

The owning host provisions extensions, credentials, SQL policy, writer topology, and isolation.

## Agent-oriented stable views

An agent should not need to know physical table names for every backend. Adapters expose stable views or named
operations over the same logical objects.

Suggested scientific views:

```sql
bio_sources
bio_artifacts
bio_observations
bio_edges_as_of
bio_intervals
bio_variants
bio_features
bio_matrices
ontology_terms
ontology_edges
ontology_mappings
```

Suggested control projections:

```sql
bio_control_objects
bio_control_current_runs
bio_control_current_attempts
bio_control_resource_pools
bio_control_allocations
bio_control_blocked
bio_control_affordances
bio_control_events
bio_operation_profiles
```

These names are target contracts, not permission to duplicate state. They project from the owning queue, pool,
allocation, CAS, run, and observation records. The first implementation may expose equivalent named operations before
all views exist.

A bounded situation snapshot composes these relations into a compact orientation record; exact detail remains
queryable by stable handle.

## Useful extensions

| Extension | Use |
|---|---|
| `duckhts` | VCF/BCF, BAM/CRAM/SAM, FASTA/FASTQ, BED, GTF/GFF, tabix, BGZF, sequence UDFs, selected bcftools-style kernels |
| `plinking_duck` | PLINK genotypes, allele frequency, missingness, LD, PRS, PCA, GWAS-style analytics |
| `anndata` | `.h5ad` single-cell obs/var/X/layers/embeddings |
| `duckdb_zarr` | Zarr groups, arrays, chunks, dense cell scans |
| `fts` | local search over catalogs, ontology labels/synonyms, documents, and capability descriptions |
| `httpfs` | remote HTTPS/S3 data only with explicit policy and credentials |
| `postgres` | host-admitted PostgreSQL catalogs and durable-control inspection |
| `sqlite` | local SQLite scientific or control artifacts |
| `quack` | server-owned DuckDB access where the deployment accepts the protocol maturity |

Extension loading is a host-granted effect. Missing extensions fail closed rather than being installed or replaced
silently.

## Network is SQL plus an async lifecycle

`ducknng` is the DuckDB-native network and RPC substrate that the host provisions and manifest/SQL composes.

| Need | Existing surface | Use |
|---|---|---|
| One JSON/CSV/body response | `ducknng_ncurl_table` | Compose a literal or SQL-derived URL/body and materialize one response table. |
| Many request bodies | `ducknng_ncurl_aio` + collect | Launch one request per batch row, drain any-ready results, and treat status/error as data. |
| Bounded retry/fanout | `ncurlFanout` | Cap in-flight waves, retry transport/429/5xx results, fail on permanent responses, and cancel/drop handles on abort. |
| One endpoint retry | `ncurlRetry` | Use the owned volatile DuckNNG scalar and SQL recursive retry path when one request is repeated. |
| Credentialed HTTP | DuckNNG HTTP profiles | The host registers a scoped profile; SQL names only its non-secret id and receives a redacted receipt. |
| Client TLS | runtime TLS handles | Create TLS state without assuming a shared CA-file path. |
| Shared control SQL | DuckNNG RPC | Send parameterized operations to one server-owned writer authority. |

The host owns egress, extension provisioning, TLS material, credentials, rate policy, and service admission. The
library records declared source, host capability/profile receipt, result, and retry/failure outcome when the host
supplies the run store and CAS.

Push/RPC transports may also notify agents of new observations or runnable work. Notifications are accelerators; the
durable cursor and relational query close missed-event gaps.

## Foreign catalogs and control-store bridges

DuckDB's official PostgreSQL, SQLite, and MySQL extensions can attach host-admitted catalogs. A manifest may query a
release-pinned foreign scientific source, while an operational workbench may attach a control store read-only for
joined diagnostics.

Examples:

```sql
-- Scientific catalog
ATTACH '...' AS ensembl (TYPE mysql, READ_ONLY);
SELECT ... FROM ensembl.gene ...

-- Local durable control store
ATTACH 'control.sqlite' AS control (TYPE sqlite, READ_ONLY);
SELECT r.run_id, a.resources, p.path
FROM control.runs r
LEFT JOIN control.allocations a USING (run_id)
LEFT JOIN read_parquet('results/**/*.parquet') p USING (run_id);
```

Writes that determine claims, attempts, or allocations still go through the owning backend adapter. A DuckDB-attached
PostgreSQL or SQLite table is not automatically a safe implementation of the corresponding backend's claim
transaction.

Foreign-catalog references are explicit ambient host inputs, not manifest resource outputs. Resource forcing follows
unqualified and `main`-qualified local tables while leaving qualified relations to the host-attached catalog. Local
schema probes should avoid unintentionally enumerating remote metadata.

## Stable scientific views

Backends should expose stable views even when the physical source is an extension call, Parquet file, attached
database, or compute-produced staging file.

For ontology sources, port the canonical INCAtools/Semantic SQL LinkML shape rather than an application-specific
wrapper: `statements`, `prefix`, `entailed_edge`, plus generated views such as `edge`.

SQLite Semantic SQL databases are interchange artifacts; DuckDB remains the joined/queryable substrate for
agent-authored SQL and recursive closure.

`materializeSemanticSqlSourceViews` creates RDF/RDFS statement views, relation-graph `edge`, RO `part_of` / `has_part`
filters, subgraph inspection views, ChEBI conjugate-acid/base and charge views, label, definition, synonym, mapping,
deprecated-node, OBO problem, ontology-status, and term views. Optional staged prefix, textual transformation,
association, axiom annotation, evidence, and precomputed closure tables extend that same shape.

Closure tables remain reachability. Evidence, Biolink/KGX qualifiers, and source-specific weights stay on asserted
edge/source views and can be joined by consumer-specific support/path operations.

## Query economy

The agent should spend tokens and compute only where evidence requires them.

1. Inspect schemas and small bounded samples before broad queries.
2. Use exact predicates, projection, range reads, and pushdown.
3. Prefer action-cache hits and content-pinned checkpoints when their reproducibility verdict permits reuse.
4. Keep logs, plans, graph neighborhoods, and complete result tables in relations or CAS; return compact summaries and
   stable detail references.
5. Compare candidate plans using explicit estimates and empirical operation profiles; unknown estimates stay unknown.
6. Record bytes read, result size, duration, and relevant resource observations when the host can measure them
   cheaply. Do not add high-frequency telemetry without a consumer.
7. Abort or park work when a hard budget is reached; do not continue because the agent lost prompt context.

## Policy

1. Prefer a DuckDB extension or table function before writing a parser.
2. Prefer a scoped read-only SQL query before dumping data into context.
3. Do not hide semantics in filenames or opaque JSON when a typed relation should exist.
4. Always record assembly and coordinate system for genomic spans.
5. Treat file/extension range pushdown as an optimization and state exact interval semantics in SQL.
6. Preserve provenance for derived facts and control decisions.
7. For graph inference, prefer graph-as-SQL/code over graph-as-prompt.
8. Keep control-store transaction semantics in backend adapters and prove them with conformance tests.
9. Use DuckDB as the shared inspection bridge without pretending it supplies cross-backend atomicity.
10. Keep the complete result durable; previews and summaries are presentation.
