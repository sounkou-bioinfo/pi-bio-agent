# Example: a ClawBio-shaped API skill as a manifest (Variant Annotation, Ensembl VEP REST)

> **Honest tag:** this is the **same shape** as a real, named ClawBio skill —
> [*Variant Annotation*](https://github.com/ClawBio/ClawBio): "Annotate VCF variants with Ensembl VEP REST,
> ClinVar significance, gnomAD frequencies." It annotates a **batch** of variants via VEP's real multi-variant
> endpoint (`POST /vep/human/id` with an `ids` body) — the same call a whole VCF uses (chunk the VCF into id/
> region batches). This is the ClawBio half of the API bet; [`ols4-grounding`](../ols4-grounding/) reproduces
> *metacurator*'s `disambiguate`, not ClawBio.
>
> **Honest remaining limitations (two):**
> 1. *The body's ids are hard-coded demo data.* In a real skill the ids come from an UPSTREAM table (a VCF read
>    with `duckhts.read_bcf`) — and that is just SQL, the same way the url composes (`getvariable` + subqueries,
>    e.g. a body built with `json_group_array((SELECT id FROM variants))`); no bespoke templating.
> 2. *One POST ≠ a whole VCF.* VEP caps the batch (~200–1000 ids/request) and rate-limits (Ensembl REST ~15
>    req/s, `429` + `Retry-After`, hourly quota). So annotating a real VCF is a **chunked, rate-limited
>    pipeline**, not one request: chunk the variant list into batches ≤ the limit, run them through a pool
>    (`src/core/pipeline.ts` `runPipeline`) with backoff (`src/duckdb/resolvers/http-policies.ts` `withRetry`,
>    honoring `Retry-After`), and `UNION` the results. This example is one within-limit batch — the unnest-and-
>    filter SQL — not the full pipeline.

A skill that annotates a variant against [Ensembl VEP REST](https://rest.ensembl.org/) and filters for rare,
high-impact, pathogenic results is, in this substrate, **a manifest plus one SQL query** — not a bespoke client.
`manifest.json` declares the VEP REST URL as an `http.get` resource; the agent resolves it into a
`vep_annotations` table and writes the filter SQL itself.

## The skill is data, not code

The whole annotation skill is the resource declaration:

```json
{ "id": "vep_annotations", "resolver": "http.get",
  "params": { "url": "https://rest.ensembl.org/vep/human/id/rs699?content-type=application/json",
              "table": "vep_annotations", "format": "json" } }
```

VEP's `colocated_variants` already carry gnomAD allele frequencies and ClinVar `clin_sig`, so one VEP endpoint
covers all three data sources the skill names. The *same* generic `http.get` resolver serves OpenTargets,
gnomAD's own REST, or any JSON/CSV endpoint — point a new manifest at a new URL and you have a new skill, with
**zero new TypeScript**. The resolver memoizes by HTTP `ETag`, so re-annotating the same variants replays a
`304 Not Modified` instead of re-downloading.

## Running it

Network is the **host's** capability, never the agent's, granted **by composition** (which entrypoint the
operator loads), not an ambient env var. The default entrypoint injects no `fetch`, so the manifest **fails
closed**; the operator grants network by loading the explicit *networked* entrypoint:

```sh
# default: no network — http.get is unbound, this manifest fails closed
pi -e extensions/pi-coding-agent/index.ts

# explicit grant: the operator chooses the networked entrypoint, which composes a fetch in
pi -e extensions/pi-coding-agent/index-networked.ts
```

That grant only binds `http.get`'s fetch — it is *not* a general egress firewall (by design the library is not
the network sandbox). Enforce real egress control (allow/block lists, blocking internal-metadata IPs, a
deny-by-default container) at the **host** boundary; wrap the injected `fetch` in `index-networked.ts` with
whatever URL policy you need.

The VEP REST response is a nested JSON array — gene/impact under `transcript_consequences`, ClinVar `clin_sig`
and gnomAD frequency under `colocated_variants`. The agent **unnests it in SQL** and applies all three
predicates (rare, high-impact, pathogenic) — that is the agent's SQL job, not the resolver's:

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

`test/variant-annotation-example.test.ts` runs this manifest end-to-end through the host with an **injected mock
fetch** returning a realistic nested VEP envelope (no live network). Its assertions prove each predicate is
load-bearing: a benign common variant, a common pathogenic one, **and a rare pathogenic *moderate*-impact one
(excluded only by the high-impact filter)** are all dropped, leaving the rare high-impact pathogenic hits. (The
mock simplifies VEP's gnomAD frequency map to one `gnomad_af` field so the example stays about the
unnest-and-filter pattern, not VEP frequency-map wrangling.)
