# Example: an API skill as a manifest (OLS4 term grounding)

A ClawBio skill that "looks up an ontology term against [OLS4](https://www.ebi.ac.uk/ols4/)" is, in this
substrate, **a manifest plus one SQL query** — not a bespoke client. `manifest.json` declares the OLS4 search
URL as an `http.get` resource; the agent resolves it into a `ols4_candidates` table and writes the grounding
SQL itself.

## The skill is data, not code

The whole "OLS4 grounding skill" is the resource declaration:

```json
{ "id": "ols4_candidates", "resolver": "http.get",
  "params": { "url": "https://www.ebi.ac.uk/ols4/api/search?q=asthma&ontology=mondo&fieldList=obo_id,label",
              "table": "ols4_candidates", "format": "json" } }
```

The *same* generic `http.get` resolver serves OpenTargets, gnomAD, or any JSON/CSV REST endpoint — point a new
manifest at a new URL and you have a new "skill", with **zero new TypeScript**. The resolver memoizes by HTTP
`ETag`, so re-grounding the same endpoint replays a `304 Not Modified` instead of re-downloading.

## Running it

Network is the **host's** opt-in, never the agent's. The library injects `fetch`; nothing reaches the network
ambiently. The Pi extension binds the runtime's `fetch` only when the operator sets `PI_BIO_ENABLE_NETWORK=1`,
so the manifest **fails closed** by default:

```sh
PI_BIO_ENABLE_NETWORK=1 pi -e extensions/pi-coding-agent/index.ts
```

**Scope of the gate (do not over-trust it):** `PI_BIO_ENABLE_NETWORK` only binds `http.get`'s fetch. It is *not*
a general egress firewall — by design the library is not the network sandbox. Other resolvers
(`duckdb.file_scan`, `duckhts.read_bcf`, `duckdb.sql_materialize`) can still read remote URIs if your host/DuckDB
allows it, and `http.get` does no SSRF allowlisting. Enforce real egress control (allow/block lists, blocking
internal-metadata IPs, a deny-by-default container) at the **host** boundary — and have your injected `fetch`
enforce any URL policy you need.

Then the agent calls `bio_query` with this manifest and grounds with ordinary SQL, e.g.:

```sql
SELECT obo_id, label
FROM ols4_candidates
WHERE lower(label) = 'asthma'      -- exact-match projection tier; synonym/closure tiers are just more SQL
```

The OLS4 `search` response is materialized as-is by `read_json_auto`; if the endpoint returns a nested
`{ response: { docs: [...] } }` envelope the agent unnests it in SQL (`SELECT unnest(response.docs) ...`) — that
is the agent's SQL job, not the resolver's.

`test/ols4-grounding-example.test.ts` runs this manifest end-to-end through the host with an **injected mock
fetch** (no live network), proving the manifest → resolved table → grounding SQL path works as data.
