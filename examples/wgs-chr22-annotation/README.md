# Example: WGS chr22 annotation — real VCF → duckhts → chunked VEP → ClinVar → rare/high-impact

The two-pillar flagship (COMPUTE = duckhts/htslib; NETWORK = ducknng HTTP) on **real data**: a whole-genome
sequencing VCF, annotated against Ensembl VEP's batch endpoint in chunks, joined to ClinVar, filtered to the
canonical **rare + high-impact (LoF)** set — the same shape as `rare-high-impact` (`rhi_01`), but end-to-end over
a real chromosome instead of a fixture CSV.

```
chr22 region  → duckhts read_bcf (htslib region read via .tbi)  → 2,731 variants
              → VCF-format strings, 200/batch                    → 14 VEP /region batches
              → ncurl_aio launch + loop-drain + retry (host loop) → 14/14 OK, round 1
              → ducknng_parse_body (nested envelope → STRUCT[])   → 2,048 annotated
              → join real ClinVar                                 → rare + high-impact in SQL
```

## What is SQL and what is host code (and why)

Almost all of it is SQL: the duckhts reads, the batching, the body composition, the parse, the ClinVar join, and
the filter. **One** piece is host code — the chunked fanout loop in
[`src/duckdb/ncurl-fanout.ts`](../../src/duckdb/ncurl-fanout.ts) — and the README is honest about *why*:

- A whole VCF exceeds VEP's per-request id cap (~200–1000), so annotation is **many** POST requests.
- ducknng's IO **table** functions (`ducknng_ncurl` / `_ncurl_table`) reject correlated column args ("only
  literals"), and a recursive CTE over them is constant-folded to a single call — so a per-chunk, retried loop
  **cannot** live in one `SELECT` (all verified).
- The **scalar** launcher `ducknng_ncurl_aio(url, …)` *does* take a per-row column body, so one statement
  launches one real request per batch. The **drain** (`ducknng_ncurl_aio_collect`, an any-ready collector — not a
  wait-for-all barrier) and the **status-driven retry** (`WHERE status NOT BETWEEN 200 AND 299` — errors are
  *values*, not exceptions) are the loop. That loop is `ncurlFanout`.

`test/ncurl-fanout.test.ts` proves the loop **deterministically** — a local ducknng server whose POST route
validates the `{variants}` body and 503s the first two calls (server-side sequence) before 200, so the retry
path is exercised with no external network.

## Running it (live)

```sh
# the sample VCF needs a tabix index for the region read:
tabix -p vcf /path/to/your.vcf.gz                 # builds your.vcf.gz.tbi (a few seconds)
npm run build
WGS_VCF=/path/to/your.vcf.gz CLINVAR_VCF=/path/to/clinvar.vcf.gz \
  WGS_REGION=chr22:23000000-24000000 node examples/wgs-chr22-annotation/live.mjs
```

The VCF must be **GRCh38** (Ensembl REST default) and bgzipped + indexed; ClinVar contigs are `22` (the script
strips the `chr` prefix when reading ClinVar and when building VEP strings). duckhts and ducknng must be
provisioned (`INSTALL duckhts; INSTALL ducknng FROM community`).

## A real result (chr22:23–24 Mb, sample WG010)

```
funnel: { annotated_gene_variants: 3238, rare: 958, high_impact: 8, in_clinvar: 46, clinvar_pathogenic: 0 }
RARE + HIGH-IMPACT (LoF) hits:
  BCR      23273614 A>G  splice_acceptor  AF 0  (not in ClinVar)
  BCR      23289614 T>C  stop_lost        AF 0  (not in ClinVar)
  CHCHD10  23766225 G>A  stop_gained      AF 0  [Benign]
  CHCHD10  23767587 T>G  splice_acceptor  AF 0  [Benign]
  RAB36    23156147 C>CA frameshift       AF 0  (not in ClinVar)
```

Note `clinvar_pathogenic: 0` is a **true negative**, not a bug — every ClinVar variant the sample carries in this
region is `[Benign]`/`[Benign/Likely_benign]`. And `CHCHD10` (an ALS/FTD gene) has a HIGH-impact `stop_gained`
that ClinVar calls *Benign* — exactly why you annotate against multiple sources rather than trust consequence
alone. The `rare + high-impact` set is the defensible candidate list; ClinVar significance is a supplementary
column, often absent for novel WGS calls.

## Caveats (honest)

- **Concurrency / politeness.** `ncurlFanout` launches all pending batches at once; a whole chromosome is
  hundreds of batches and would flood Ensembl REST. For a full chromosome, cap region size (or add a
  concurrency wave to `ncurlFanout`) and respect the ~15 req/s + hourly quota — the retry honors transient 503s
  but is not a substitute for rate limiting.
- **gnomAD AF** is read from VEP's allele-keyed `colocated_variants[].frequencies.<ALT>.gnomadg`; a variant
  absent from gnomAD is treated as rare (AF 0). This is the genome (`gnomadg`) frequency, not a population
  subset.
- **First ALT only.** Multiallelic sites use `ALT[1]`; normalize/split upstream for full multiallelic handling.
