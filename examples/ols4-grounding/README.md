# OLS4 candidate grounding

The manifest declares an OLS4 search response through `duckdb.sql_materialize` and DuckNNG HTTP. The actor supplies
the text query, inspects the returned candidate schema, and chooses one source-provided CURIE or abstains.

This follows Metacurator's typed disambiguation boundary:

1. deterministic retrieval produces candidate ids and labels;
2. SQL applies exact or lexical tiers;
3. a model or human may choose only among validated candidates;
4. no candidate is an explicit abstention.

The local test route makes the request hermetic. A live host must provision DuckNNG/TLS or bind `http.get`, and must
own its network and credential policy.

```sh
pi-bio-agent describe examples/ols4-grounding/manifest.json
```

The example proves source retrieval and candidate-choice mechanics. It does not prove a phenotype-grounding quality
gain; the workbench grounding benchmark measures retrieval contracts separately.
