# Example: a grounding skill as a manifest (metacurator `disambiguate`, over OLS4)

This folds in [metacurator](https://github.com/seandavi/metacurator)'s `disambiguate` discipline — ground a text
term to **one** of the provided grounded CURIEs, or abstain (`None`) — **SQL all the way down**. `manifest.json`
is a `duckdb.sql_materialize` resource whose SQL fetches [OLS4](https://www.ebi.ac.uk/ols4/) with
`ducknng_ncurl_table` — a SQL table function — so there is **no TS resolver**: the URL is composed in SQL
(`getvariable('query')` + `url_encode`), agent params are DuckDB session variables, and the JSON response is
parsed into `ols4_candidates` by ducknng. The agent grounds with one more SQL line.

```sql
-- the resource: an HTTP fetch that IS SQL
SELECT * FROM ducknng_ncurl_table(
  coalesce(getvariable('ols4_base'), 'https://www.ebi.ac.uk/ols4/api') || '/search?q=' || url_encode(getvariable('query'))
    || '&ontology=' || url_encode(coalesce(getvariable('ontology'), 'mondo')) || '&fieldList=obo_id,label',
  'GET', NULL, NULL, 20000, coalesce(getvariable('tls'), 0)::UBIGINT)
```

The host provisions ducknng once via `duckdbInitSql` (`INSTALL ducknng FROM community; LOAD ducknng`) and, for
HTTPS, a TLS config (`SET VARIABLE tls = ducknng_tls_config_from_files(NULL, '/etc/ssl/certs/ca-certificates.crt',
'', 1)`); the agent supplies `{query}` as a binding. The test is **deterministic** — a *local ducknng server*
(`ducknng_start_server` + `ducknng_register_http_route` + `ducknng_http_json`) is the fixture, so it needs no
external network. (ducknng's community build is unsigned, so the host opens the db with
`duckdbConfig: { allow_unsigned_extensions: "true" }`.) `http.get` (TS resolver + injected fetch) remains the
fallback when a DuckDB version has no ducknng build.

> **Honest tag:** this is a **metacurator** concrete, *not* a ClawBio skill. ClawBio has no standalone OLS /
> ontology-grounding skill — its API skills are things like *Variant Annotation* (Ensembl VEP REST / ClinVar /
> gnomAD) and *GWAS Lookup*. The named concrete reproduced here is metacurator's `disambiguate`. (The named
> ClawBio concretes we reproduce live in `examples/rare-high-impact/` → ClawBio `rhi_01`.)

## The skill is data, not code

The whole grounding skill is the resource declaration:

```json
{ "id": "ols4_candidates", "resolver": "http.get",
  "params": { "url": "https://www.ebi.ac.uk/ols4/api/search?q=asthma&ontology=mondo&fieldList=obo_id,label",
              "table": "ols4_candidates", "format": "json" } }
```

The *same* generic `http.get` resolver serves OpenTargets, gnomAD, or any JSON/CSV REST endpoint — point a new
manifest at a new URL and you have a new "skill", with **zero new TypeScript**. The resolver memoizes by HTTP
`ETag`, so re-grounding the same endpoint replays a `304 Not Modified` instead of re-downloading.

## Running it

Network is the **host's** capability, never the agent's, and it is granted **by composition** — not by an
ambient env var (which would inherit across forks/embeddings and is invisible to the model). The default
entrypoint injects no `fetch`, so the manifest **fails closed**. The operator grants network by loading the
explicit *networked* entrypoint:

```sh
# default: no network — http.get is unbound, this manifest fails closed
pi -e extensions/pi-coding-agent/index.ts

# explicit grant: the operator chooses the networked entrypoint, which composes a fetch in
pi -e extensions/pi-coding-agent/index-networked.ts
```

Choosing `index-networked.ts` is a visible, auditable decision the human running Pi makes; the agent can never
turn its own egress on. **Scope (do not over-trust it):** that grant only binds `http.get`'s fetch. It is *not* a
general egress firewall — by design the library is not the network sandbox. Other resolvers (`duckdb.file_scan`,
`duckhts.read_bcf`, `duckdb.sql_materialize`) can still read remote URIs if your host/DuckDB allows it, and
`http.get` does no SSRF allowlisting. Enforce real egress control (allow/block lists, blocking internal-metadata
IPs, a deny-by-default container) at the **host** boundary — wrap the injected `fetch` in `index-networked.ts`
with whatever URL policy you need.

Then the agent calls `bio_query` with this manifest and grounds with ordinary SQL, e.g.:

```sql
SELECT obo_id, label
FROM ols4_candidates
WHERE lower(label) = 'asthma'      -- exact-match projection tier; synonym/closure tiers are just more SQL
```

Per `disambiguate`, this returns **one** grounded CURIE or zero rows (abstain) — never an invented id. The
candidate set comes from the source; SQL only chooses among provided CURIEs or returns nothing.

The OLS4 `search` response is materialized as-is by `read_json_auto`; if the endpoint returns a nested
`{ response: { docs: [...] } }` envelope the agent unnests it in SQL (`SELECT unnest(response.docs) ...`) — that
is the agent's SQL job, not the resolver's.

`test/ols4-grounding-example.test.ts` runs this manifest end-to-end through the host with an **injected mock
fetch** (no live network), proving the manifest → resolved table → grounding SQL path works as data.
