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
external network. The host opens the db with `duckdbConfig` — good practice regardless, since that's where S3
secrets, `cache_httpfs` settings, and `allow_unsigned_extensions` live (the *community* ducknng is signed; we
pass `allow_unsigned_extensions` defensively because a cached or local *dev* build may not be). `http.get` is a
separate TS resolver path for hosts that deliberately choose an injected JS `fetch` port.

> **Honest tag:** this is a **metacurator** concrete, *not* a ClawBio skill. ClawBio has no standalone OLS /
> ontology-grounding skill — its API skills are things like *Variant Annotation* (Ensembl VEP REST / ClinVar /
> gnomAD) and *GWAS Lookup*. The named concrete reproduced here is metacurator's `disambiguate`. (The named
> ClawBio concretes we reproduce live in `examples/rare-high-impact/` → ClawBio `rhi_01`.)

## The skill is data, not code

The whole grounding skill is the `duckdb.sql_materialize` resource shown above — a `ducknng_ncurl_table` GET whose
URL is composed in SQL. That *same* generic SQL-materialize path serves OpenTargets, gnomAD, or any JSON/CSV REST
endpoint — point a new manifest at a new URL and you have a new "skill", with **zero new TypeScript** (a new API is
an `ncurl_table` call, not a new resolver). The separate `http.get` resolver has its own host-injected `fetch` and
HTTP `ETag` reuse semantics for applications that choose that path.

## Running it

Network is the **host's** capability, never the agent's. For the SQL-native path the host provisions ducknng once
via `duckdbInitSql` (`INSTALL ducknng FROM community; LOAD ducknng`) plus a TLS config for HTTPS (shown above), and
egress is then whatever the host's DuckDB/sandbox allows — the library is not the egress firewall. The `http.get`
resolver is granted differently: **by composition**, not an ambient env var (which would inherit across
forks/embeddings and is invisible to the model). Its default entrypoint injects no `fetch`, so an `http.get`
manifest **fails closed**; the operator grants network by loading the explicit *networked* entrypoint:

```sh
# default: no network — http.get is unbound, an http.get manifest fails closed
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

The OLS4 `search` response is materialized as-is by the resolver; if the endpoint returns a nested
`{ response: { docs: [...] } }` envelope the agent unnests it in SQL (`SELECT unnest(response.docs) ...`) — that
is the agent's SQL job, not the resolver's.

`test/ols4-grounding-example.test.ts` runs this manifest end-to-end through the host against a **local ducknng
server** fixture (`ducknng_start_server` + a registered HTTP route, no external network), proving the manifest →
`ncurl_table` fetch+parse → grounding SQL path works as data. (It skips when a DuckDB build has no community ducknng.)
