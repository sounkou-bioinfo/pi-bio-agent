# Manifest Syntax

A manifest declares resources and optional operations. It is not where every user question has to live.

- Put **data access** in the manifest: resolvers, resources, table names, extension needs, source URLs/paths.
- Put **the current question** in an ad-hoc `pi-bio-agent query --sql ...` call.
- Put SQL into `operations` only after the workflow is stable, repeated, and worth testing as a named contract.

Required top-level shape:

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "task-id",
  "version": "0.1.0",
  "title": "Task title",
  "description": "What data this manifest declares and what it is for.",
  "provides": {
    "resolvers": [],
    "resources": [],
    "operations": []
  }
}
```

## Concepts

- `resolvers`: available mechanisms for turning a resource into a table or artifact.
- `resources`: declared inputs; each resource names a resolver and `params`.
- `params.table`: DuckDB table name materialized by the resource.
- `operations`: optional named, reusable workflows; do not create one for every ad-hoc question.

## Local File Resource

Use `duckdb.file_scan` for DuckDB-readable local files.

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "variant-demo",
  "version": "0.1.0",
  "title": "Variant demo",
  "description": "Expose a local variant table for agent-authored SQL.",
  "provides": {
    "resolvers": [
      {
        "id": "duckdb.file_scan",
        "version": "0.1.0",
        "title": "DuckDB file scan",
        "description": "Read a DuckDB-native file into a table.",
        "output": { "mode": "table" }
      }
    ],
    "resources": [
      {
        "id": "variants",
        "title": "Variants",
        "kind": "virtual",
        "resolver": "duckdb.file_scan",
        "params": { "path": "data/variants.csv", "table": "variants" }
      }
    ]
  }
}
```

Then answer a new question with ad-hoc SQL:

```sh
pi-bio-agent query variant-demo.json --db :memory: --sql "DESCRIBE variants"
```

## SQL Materialization Resource

Use `duckdb.sql_materialize` when a table is best expressed as a read-only DuckDB query: projections, joins, HTTPFS
reads, DuckDB extension table functions, GraphQL calls through ducknng, or SemanticSQL-shaped views.

```json
{
  "id": "derived_edges",
  "title": "Derived edges",
  "kind": "virtual",
  "resolver": "duckdb.sql_materialize",
  "params": {
    "table": "derived_edges",
    "extensions": ["httpfs"],
    "declaredSources": ["https://example.org/data.tsv.gz"],
    "sql": "SELECT * FROM read_csv_auto('https://example.org/data.tsv.gz', delim='\\t', header=true)"
  }
}
```

`extensions` are loaded, not installed. Use `--init-sql "INSTALL ext FROM community; LOAD ext;"` when the host allows
provisioning. If the extension is unavailable, the resolver fails clearly.

## Useful Examples

List packaged examples/templates first:

```sh
pi-bio-agent catalog
pi-bio-agent catalog --query graphql
```

The catalog returns manifest paths, resources/tables, declared operations, resolvers, and host requirements. It
is discovery only. Validate and assess one result before execution:

```sh
pi-bio-agent describe <manifestPath>
```

Then run `pi-bio-agent query` or `pi-bio-agent run` against it.

- `examples/variant-counts/manifest.json`
- `examples/connectors/clinvar-region.json`
- `examples/connectors/opentargets-graphql.json`
- `examples/monarch-kg-http/manifest.json`
- `examples/compute-run/manifest.json`
