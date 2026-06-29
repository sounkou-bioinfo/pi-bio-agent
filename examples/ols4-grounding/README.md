# Example: a grounding skill as a manifest (metacurator `disambiguate`, over OLS4)

This folds in [metacurator](https://github.com/seandavi/metacurator)'s `disambiguate` discipline — ground a text
term to **one** of the provided grounded CURIEs, or abstain (`None`) — expressed as **a manifest plus one SQL
query**, not a bespoke client. `manifest.json` declares an [OLS4](https://www.ebi.ac.uk/ols4/) search URL as an
`http.get` resource; the agent resolves it into a `ols4_candidates` table and grounds with SQL itself.

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
