#!/bin/sh
# A FILES-ONLY tool: it returns no rectangular value — it just writes files into its work dir (cwd), exactly like
# `samtools index` (a .bai), `bcftools` (a .vcf.gz), or a plot renderer (a .svg). process.compute passes no in.arrow
# and expects no out.arrow (resultTable="artifacts"); the host captures the DECLARED outputs below into CAS.
set -e
printf 'chr22\t10510000\t10520000\tregion_a\nchr22\t10600000\t10620000\tregion_b\n' > regions.bed
printf 'metric\tvalue\nregions\t2\ntotal_bp\t30000\n' > summary.tsv
