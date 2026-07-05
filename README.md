# pi-bio-workbench

`pi-bio-workbench` is the application repo that exercises `pi-bio-agent` as a real workbench. It is intentionally
separate from the substrate: application bindings own manifests, fixtures, report conventions, host policy, and
tests; `pi-bio-agent` owns the durable primitives.

The first binding is clinical genomics. It demonstrates the two rare-disease directions over one evidence graph:

- **Direct:** variant/genotype-first triage, from observed variants to rare high-impact candidates and abstentions.
- **Inverted:** phenotype/disease-first search, from observed HPO terms to gene/disease hypotheses and then back to
  the genome for support or absence.

Both directions produce one evidence packet, recorded in the same `bio_observations` ledger as the scientific runs.
The packet is an app convention, not a substrate primitive.

This is not a complete clinical classification kernel. Known clinical-kernel edge cases must become fixtures before
any classifier claim: carrier guards for recessive genes, SNV/CNV unification, CNV dosage tracks, loss-of-function
entry gates, common-pathogenic exception lists, benign blocking for hotspot evidence, family QC, and phenotype
information-content denominators. This repo starts one layer above that: it routes evidence, abstentions, gaps, and
review targets through the substrate.

## Run

```sh
npm install
npm run check
npm run demo:clinical
```

The app depends on the sibling substrate through `"pi-bio-agent": "file:../pi-bio-agent"`.
