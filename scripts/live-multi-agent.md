

# Live multi-agent run — evidence

`scripts/live-multi-agent.ts` is a **dogfood** (not a unit test —
non-deterministic, spawns real LLM agents). It runs a `StudyScaffold`
where **each step’s worker is a separate `pi` process**, and the workers
communicate **only through access-list artifacts the host threads
between them** — never by opening a shared DuckDB file, so the
process-exclusive RW lock is never touched. This is an
access-list-shaped Pi harness smoke, not a Fugu implementation.

Run it with: `npx tsx scripts/live-multi-agent.ts` (requires the `pi`
CLI + a configured provider).

## Recorded run (2026-06-29)

    === LIVE multi-agent scaffold run: each step = a separate pi process; comms via access-list artifacts ===
      [host] spawned pi process pid=1560667 for step 'define-vcf'
      [host] spawned pi process pid=1560731 for step 'followups'

    ### define-vcf  (depends_on: none)
    A VCF (Variant Call Format) file is a standard text format used in genomics to store genetic variants such as
    SNPs, insertions, deletions, and structural variants relative to a reference genome. It includes metadata,
    genomic coordinates, reference and alternate alleles, quality/filter information, and optional sample genotype data.

    ### followups  (depends_on: define-vcf)
    Which reference genome build was used for the VCF coordinates?
    Does the VCF include genotype/sample-level fields, and if so which samples?

    execution order: define-vcf -> followups

**What it proves:** two *distinct* OS processes ran (`pid=1560667`,
`pid=1560731`); the second agent (`followups`) consumed the first’s
produced note via its access list (its questions are grounded in the
upstream VCF definition); execution was topological; and no shared
mutable database was opened by either worker — the only shared channel
was the content of the access-list artifacts. It does not exercise
learned worker selection, long-lived function-call routing, durable
resume, or shared inter-workflow tool memory.
