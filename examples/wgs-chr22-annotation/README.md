# Indexed WGS region annotation

[`live.mjs`](live.mjs) composes the implemented online path over a selected genomic region:

1. `duckhts.read_bcf` reads an indexed VCF region;
2. SQL normalizes selected alleles and builds Ensembl VEP `/region` batches of at most 200;
3. `ncurlFanout` applies bounded launch, complete drain, transient retry, cancellation, and terminal failure;
4. DuckNNG parses responses into relations;
5. SQL joins ClinVar-shaped evidence and reduces candidate rows.

```sh
WGS_VCF=/path/to/case.vcf.gz \
CLINVAR_VCF=/path/to/clinvar.vcf.gz \
WGS_REGION=chr22:23000000-24000000 \
node examples/wgs-chr22-annotation/live.mjs
```

The host must provision DuckHTS, DuckNNG, TLS, network admission, and source identities. VCF and ClinVar inputs must
use a compatible assembly and normalized variant representation. Missing frequency must remain missing rather than
being coerced to zero; multiallelic fields must remain aligned by ALT ordinal.

The deterministic fanout tests use a local route with transient failures. A live run proves current endpoint and
schema compatibility only; it is not a stable biomedical result or clinical screen.
