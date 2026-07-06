# Monarch KG over HTTP

This example binds a real foreign knowledge graph without a bespoke resolver:

1. DuckDB `httpfs` reads Monarch's downloadable disease-to-phenotypic-feature KGX TSV over HTTPS.
2. `duckdb.sql_materialize` stages it as a table with canonical SemanticSQL edge columns: `subject`,
   `predicate`, `object`, `attrs`, and `trust`.
3. The graph can then be queried directly or projected with a `GraphProjectionProfile` into `bio_edges` /
   `entailed_edge`.

The default source is a pinned Monarch KG release:

```text
https://data.monarchinitiative.org/monarch-kg/2026-04-14/tsv/all_associations/disease_to_phenotypic_feature_association.all.tsv.gz
```

Run the declared operation with a host that has `httpfs` provisioned:

```sh
npm run build
node dist/cli/bin.js run examples/monarch-kg-http/manifest.json \
  --operation monarch.disease_phenotypes \
  --bindings '{"disease_id":"MONDO:0007947","limit":5}' \
  --init-sql 'LOAD httpfs' \
  --db :memory:
```

Tests copy the manifest and replace the source URL in both the SQL and `declaredSources`, so the deterministic
fixture does not depend on Monarch uptime and the resolver receipt still reports the effective source.

The manifest assumes the KGX edge-file columns used by this release (`subject`, `predicate`, `object`, `negated`,
labels, sources, publications, and evidence). A future Monarch schema change should fail at materialization time
rather than silently projecting different semantics.
