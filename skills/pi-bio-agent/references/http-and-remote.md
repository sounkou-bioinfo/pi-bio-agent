# HTTP, GraphQL, And Remote Data

Remote data is still declared data. The manifest names the URL/source and the resolver; ad-hoc SQL or a declared
operation queries the resulting DuckDB table.

## `http.get`

`http.get` is a host-injected fetch resolver. It works only when the host binds network. If it is unbound, the failure
is meaningful: the host has not granted that capability.

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "api-demo",
  "version": "0.1.0",
  "title": "API demo",
  "provides": {
    "resolvers": [
      {
        "id": "http.get",
        "version": "0.1.0",
        "title": "HTTP GET -> table",
        "description": "Fetch an HTTP JSON body into a table through the host-supplied fetch port.",
        "output": { "mode": "table" }
      }
    ],
    "resources": [
      {
        "id": "api_response",
        "title": "API response",
        "kind": "virtual",
        "resolver": "http.get",
        "params": {
          "table": "api_response",
          "format": "json",
          "method": "GET",
          "url": "https://example.org/api?q=BRCA2&format=json"
        }
      }
    ]
  }
}
```

## SQL-Native HTTP With ducknng

Use `duckdb.sql_materialize` plus `ducknng_ncurl_table` when ducknng is provisioned. This also covers GraphQL POSTs.

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "opentargets-example",
  "version": "0.1.0",
  "title": "OpenTargets GraphQL example",
  "provides": {
    "resolvers": [
      {
        "id": "duckdb.sql_materialize",
        "version": "0.1.0",
        "title": "SQL materialize",
        "description": "Materialize a table from a read-only SELECT.",
        "output": { "mode": "table" }
      }
    ],
    "resources": [
      {
        "id": "graphql_response",
        "title": "GraphQL response",
        "kind": "virtual",
        "resolver": "duckdb.sql_materialize",
        "params": {
          "table": "graphql_response",
          "extensions": ["ducknng"],
          "declaredSources": ["https://api.platform.opentargets.org/api/v4/graphql"],
          "sql": "SELECT * FROM ducknng_ncurl_table('https://api.platform.opentargets.org/api/v4/graphql', 'POST', '[{\"name\":\"Content-Type\",\"value\":\"application/json\"},{\"name\":\"Accept\",\"value\":\"application/json\"}]', json_object('query', '{ target(ensemblId: \"ENSG00000157764\") { id approvedSymbol } }')::VARCHAR::BLOB, 30000, coalesce(getvariable('tls'), 0)::UBIGINT)"
        }
      }
    ]
  }
}
```

Run with provisioning when allowed:

```sh
pi-bio-agent query opentargets-example.json \
  --db :memory: \
  --init-sql "INSTALL ducknng FROM community; LOAD ducknng;" \
  --sql "DESCRIBE graphql_response"
```

## Remote Files Through DuckDB

For remote CSV/Parquet/TSV/etc., use DuckDB table functions inside `duckdb.sql_materialize`, typically with `httpfs`.

```json
{
  "id": "remote_edges",
  "title": "Remote edges",
  "kind": "virtual",
  "resolver": "duckdb.sql_materialize",
  "params": {
    "table": "remote_edges",
    "extensions": ["httpfs"],
    "declaredSources": ["https://example.org/edges.tsv.gz"],
    "sql": "SELECT * FROM read_csv_auto('https://example.org/edges.tsv.gz', delim='\\t', header=true, compression='auto')"
  }
}
```

## Failure Semantics

- `resolver 'http.get' is declared but no implementation is bound`: use a host that grants `http.get`, or switch to a
  provisioned SQL-native HTTP route.
- `LOAD ducknng` or `LOAD httpfs` fails: the host has not provisioned that DuckDB extension.
- If a host chooses shell or language-level fetching instead of a manifest resolver, make that an explicit
  host/application decision and record the reason.

## Credentialed APIs

Do not put tokens in a manifest, SQL string, `--bindings`, or `--init-sql` command line.

Preferred shapes:

- Pi/application host injects `http.get` with an auth policy. The manifest still names only the non-secret URL/query
  shape.
- Host registers a scoped ducknng HTTP profile on the DuckDB connection. Agent-visible SQL passes only a non-secret
  `profile_id`; ducknng injects the secret header and can return a secret-free profile receipt for run provenance.
- A declared operation intentionally consumes protected host state. Ad-hoc queries should not read protected session
  variables into result rows.

The plain CLI can load provisioned extensions and pass non-secret bindings, but it is not a credential manager today.
