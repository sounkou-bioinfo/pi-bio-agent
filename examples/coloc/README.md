# Post-GWAS colocalization — the two-pillar flagship (walking skeleton)

This is the **fruitfulness-in-real-research** proof of the bet: post-GWAS colocalization (the shape of
[`~/PostGWAS` + `~/coloclize`](../../docs/refinments.md)) solved as a **manifest** — the DATA and COMPUTE pillars
composed, not a bespoke pipeline. The agent asks *"do this GWAS signal and this eQTL signal share a causal
variant?"* and the substrate answers with provenance.

## The DAG (each step a receipted resource)

```
gwas_locus ┐
           ├─(SQL)→ harmonized ─(Arrow IPC → R)→ coloc_result
eqtl_locus ┘        (DATA pillar)   (COMPUTE pillar)
```

1. **`gwas_locus`, `eqtl_locus`** (`file_scan`) — the locus sumstats. In production these are **tabix
   region-extracts** via the `duckhts` tier; here they are small CSVs so the example is self-contained.
2. **`harmonized`** (`sql_materialize`, the **DATA pillar**) — joins the two on variant, **aligns alleles**
   (keeps same-orientation, **flips** the eQTL beta when alleles are swapped, **drops** allele mismatches), and
   sets `varbeta = se²`. Pure SQL. (`rs9` is swapped → its beta flips `-0.07 → +0.07`; `rs12` mismatches → dropped,
   leaving 11 of 12 SNPs.)
3. **`coloc_result`** (`process.compute`, the **COMPUTE pillar**) — exports the harmonized bundle as Arrow IPC to
   an out-of-process R run of **`coloc.abf`** (Giambartolomei 2014 — per-SNP approximate Bayes factors + the
   H0–H4 posterior combination, a thing SQL is poor at) and reads the posteriors back as a table. Uses the real
   `coloc` package when present, else a faithful inline implementation of the same algorithm.

## Recorded run (2026-06-30)

```
  PP.H0        0   (nsnps=11, engine=coloc::coloc.abf)
  PP.H1        0
  PP.H2        0
  PP.H3        0
  PP.H4        1   (shared causal variant — COLOCALIZED)
```

The synthetic locus has a shared causal at `rs6` (strong signal in *both* traits), so the real `coloc::coloc.abf`
concludes `PP.H4 ≈ 1.0`: the GWAS and eQTL share a causal variant. The DATA pillar (SQL allele harmonization) and
the COMPUTE pillar (out-of-process R coloc over Arrow IPC) **composed end to end**, with a receipt at every step
(file digests, the harmonization SQL digest, the `coloc.R` command digest).

Run the test: `npm test` (gated on `Rscript` + the R `arrow` package).

## How it thickens (and why it's the finish line)

This skeleton is `coloc.abf` on **one locus + one tissue** (no LD matrix needed). Thickening it is exactly what
drives the last deferred substrate pieces — it is **one flagship, not three remaining promises**:

- **per-tissue fan-out** over real GTEx eQTL tissues = the partition+map DAG (`runPipeline`);
- **PLINK2 reference LD** + **SuSiE/HyPrColoc** = richer COMPUTE process ops (these need LD);
- a multi-output, long-running coloc run = the first real consumer of the **`process` artifact transport**
  (file outputs → CAS);
- recording each locus's posteriors as **time-versioned, provenance-bearing KG facts** = Phase-4 `record`.

So coloc is the consumer that converts the artifact transport and the judgment-recording from *deferred* to
*built-because-driven*.
