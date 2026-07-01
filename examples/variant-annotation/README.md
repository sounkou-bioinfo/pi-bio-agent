# Example: a ClawBio-shaped API skill as a manifest (Variant Annotation, Ensembl VEP REST) — SQL all the way down

> **Honest tag:** this is the **same shape** as a real, named ClawBio skill —
> [*Variant Annotation*](https://github.com/ClawBio/ClawBio): "Annotate VCF variants with Ensembl VEP REST,
> ClinVar significance, gnomAD frequencies." It annotates a **batch** of variants via VEP's real multi-variant
> endpoint (`POST /vep/human/id` with an `ids` body). This is the ClawBio half of the API bet;
> [`ols4-grounding`](../ols4-grounding/) reproduces *metacurator*'s `disambiguate`, not ClawBio.

The skill is now **SQL all the way down**: no TS resolver. The `POST` to VEP is `ducknng_ncurl_table` — a SQL
table function — and ducknng parses VEP's deeply-nested JSON response (`transcript_consequences[]` +
`colocated_variants[]`) into proper `STRUCT(...)[]` columns the agent `UNNEST`s. The agent supplies the batch as
the JSON-array binding `{vep_ids}` (it **discovers/chooses** the ids — the manifest does *not* hardcode them), so
the POST body composes in SQL (`json_object('ids', json(getvariable('vep_ids')))`) — a scalar, no subquery.

```sql
-- the resource: a POST to VEP that IS SQL (no TS resolver). headers_json is arg 3; the BLOB body is arg 4.
SELECT * FROM ducknng_ncurl_table(
  coalesce(getvariable('vep_base'), 'https://rest.ensembl.org') || '/vep/human/id',
  'POST',
  '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]',
  json_object('ids', json(getvariable('vep_ids')))::VARCHAR::BLOB,   -- body composed from the {vep_ids} binding
  20000, coalesce(getvariable('tls'), 0)::UBIGINT)
```

The same generic path serves OpenTargets, gnomAD's own REST, or any JSON endpoint — point a new manifest at a new
URL with new params, **zero new TypeScript**. `http.get` (the TS resolver + injected fetch) remains the fallback
when a DuckDB version has no ducknng build.

## Single batch is pure SQL; chunking a whole VCF is request fanout (not a row-count limit)

A within-limit batch of variants annotates in pure SQL; only splitting a *whole VCF* into many capped POSTs is
a host-driven fanout. Precisely:

- **One within-limit batch is one POST, fully SQL** (proven by the deterministic test below). `ncurl_table`
  returns a large *response* fine (many rows); response size is never the constraint.
- **The body can be built from upstream rows in one statement.** Aggregate the upstream variants into one POST
  body with a **scalar subquery** that returns exactly one body value, e.g. `SET VARIABLE vep_body = (SELECT
  json_object('ids', json_group_array(id)) FROM variants)` then pass `getvariable('vep_body')::BLOB`. (On the
  pinned community **1.5.2** build a subquery placed *directly inside* the `ncurl_table` args is still rejected —
  "Table function cannot contain subqueries" — so the aggregate goes through a session variable first; a later
  build may lift that and let the scalar subquery sit inline. Either way it is one logical SQL step, and the
  `SET VARIABLE`-from-subquery is plain DuckDB, **not** ducknng-specific.)
- **The one real constraint is multi-*request* fanout.** VEP caps the batch (~200–1000 ids/request) and
  rate-limits (Ensembl REST ~15 req/s, `429` + `Retry-After`, hourly quota). Annotating a whole VCF therefore
  splits the *input* into multiple POST *requests*. `ducknng_ncurl_table` is a **bind-time dynamic-schema** table
  function, so it cannot be **lateral-correlated** for one-call-per-chunk inside a single `SELECT`. For chunk
  fanout: launch per-row `ducknng_ncurl_aio(...)` handles (it is scalar, so it *can* fire per chunk), materialize
  the aio ids, and **drain repeatedly** — `ducknng_ncurl_aio_collect(...)` is an *any-ready collector, not a
  wait-for-all barrier*, so collecting 1 of 3 launched handles is legal until you drain the rest. Or drive the
  separate calls outside one SQL statement (`src/core/pipeline.ts` `runPipeline` + `src/duckdb/resolvers/
  http-policies.ts` `withRetry`, honoring `Retry-After`), `UNION` the results. This example is one within-limit
  batch — the unnest-and-filter SQL — not the full chunked pipeline.

## Running it

The host provisions ducknng once via `duckdbInitSql` (`INSTALL ducknng FROM community; LOAD ducknng`) and, for
HTTPS, a TLS config (`SET VARIABLE tls = ducknng_tls_config_from_files(NULL, '/etc/ssl/certs/ca-certificates.crt',
'', 1)`); the agent supplies `{vep_ids}` (and may point `{vep_base}` at a fixture). The host opens the db with
`duckdbConfig` — good practice regardless, since that is where S3 secrets, `cache_httpfs` settings, and
`allow_unsigned_extensions` live (the *community* ducknng is signed; we pass `allow_unsigned_extensions`
defensively because a cached or local *dev* build may not be).

Network is the **host's** capability, never the agent's. For the SQL-native path egress is whatever the host's
DuckDB/sandbox allows (the library is not the egress firewall — enforce allow/block lists, internal-metadata-IP
blocking, and a deny-by-default container at the host boundary). For the `http.get` fallback, the operator grants
network by loading the explicit *networked* entrypoint (`pi -e extensions/pi-coding-agent/index-networked.ts`),
which composes a `fetch` in; the default entrypoint injects none, so that path fails closed.

The agent **unnests the response in SQL** and applies all three predicates (rare, high-impact, pathogenic) — the
agent's SQL job, not the resolver's:

```sql
WITH exploded AS (
  SELECT input, most_severe_consequence,
         UNNEST(transcript_consequences) AS tc,    -- gene_symbol, impact
         UNNEST(colocated_variants)      AS cv      -- clin_sig[], gnomad_af
  FROM vep_annotations
)
SELECT input, tc.gene_symbol AS gene_symbol, most_severe_consequence
FROM exploded
WHERE cv.gnomad_af < 0.01                          -- rare (gnomAD frequency)
  AND tc.impact = 'HIGH'                           -- high-impact (VEP impact)
  AND list_contains(cv.clin_sig, 'pathogenic')     -- pathogenic (ClinVar significance)
ORDER BY gene_symbol
```

`test/variant-annotation-example.test.ts` runs this manifest end-to-end **deterministically** — a *local ducknng
server* is the fixture, and its POST route **validates the `{ids}` body server-side** (it returns `400` unless
the body carries a non-empty `ids` array — so the test proves the manifest genuinely POSTs a batch, the
deterministic equivalent of inspecting the request body; no external network, no mock fetch). Its assertions
prove each predicate is load-bearing: a benign common variant, a common pathogenic one, **and a rare pathogenic
*moderate*-impact one (excluded only by the high-impact filter)** are all dropped, leaving the rare high-impact
pathogenic hits. (The fixture simplifies VEP's gnomAD frequency map to one `gnomad_af` field so the example stays
about the unnest-and-filter pattern, not VEP frequency-map wrangling.)
