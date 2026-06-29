# Example: a ClawBio API skill as a manifest (Variant Annotation, Ensembl VEP REST)

> **Honest tag:** this reproduces a **real, named ClawBio skill** —
> [*Variant Annotation*](https://github.com/ClawBio/ClawBio): "Annotate VCF variants with Ensembl VEP REST,
> ClinVar significance, gnomAD frequencies." This is the ClawBio half of the API bet (the
> [`ols4-grounding`](../ols4-grounding/) example reproduces *metacurator*'s `disambiguate`, not ClawBio).

A ClawBio skill that annotates variants against [Ensembl VEP REST](https://rest.ensembl.org/) and filters for
rare, high-impact, pathogenic ones is, in this substrate, **a manifest plus one SQL query** — not a bespoke
client. `manifest.json` declares the VEP REST URL as an `http.get` resource; the agent resolves it into a
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

Then the agent calls `bio_query` with this manifest and filters with ordinary SQL, e.g. "rare, high-impact,
pathogenic":

```sql
SELECT input, gene_symbol, most_severe_consequence
FROM vep_annotations
WHERE gnomad_af < 0.01                 -- rare (gnomAD frequency)
  AND clinvar_clin_sig = 'pathogenic'  -- ClinVar significance
ORDER BY gene_symbol
```

The real VEP REST response is a nested JSON array (`transcript_consequences`, `colocated_variants` …); the
agent unnests it in SQL (`SELECT ... unnest(colocated_variants) ...`) — that is the agent's SQL job, not the
resolver's. `test/variant-annotation-example.test.ts` runs this manifest end-to-end through the host with an
**injected mock fetch** returning flattened VEP/ClinVar/gnomAD rows (no live network), proving the manifest →
resolved table → filter SQL path works as data.
