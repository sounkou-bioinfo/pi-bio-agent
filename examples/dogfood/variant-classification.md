

# Variant classification — “most of ClawBio for free” — evidence

`scripts/variant-classification.mjs` is a **dogfood** showing that a
real ClawBio-shaped *Variant Classification* skill is a **manifest +
SQL**, not a `.ts` file. One declared manifest
(`examples/rare-high-impact`: a variants table + the LoF SO-term set)
answers many ClawBio-shaped questions with **no new code**:

1.  the **pinned, tested** operation `rare_high_impact.report` — the
    safety-critical classification with the abstention rule baked into
    SQL (unknown allele frequency is **not** counted as rare; benign LoF
    is excluded);
2.  an **ad-hoc** exploratory cut over the *same* resolved tables — the
    agent just writes SQL, no operation.

Both run through the real substrate runner (resolvers → tables →
read-only SQL → result + receipts).

Run: `npm run build && node scripts/variant-classification.mjs`

## Recorded run (2026-06-30)

    === ClawBio Variant Classification, for free: one manifest, many questions, all SQL ===

    ### 1. PINNED operation `rare_high_impact.report` (tested, abstention-aware)
        benign           1
        included         1
        no_frequency     1
        not_high_impact  1
        not_rare         1
        -> defensible rare-high-impact count = 1; ABSTAINED on 1 (unknown frequency, NOT called rare)
        receipts: /tmp/pi-bio-classify-XXXXXX/.pi/bio-agent/runs/classify/receipts.json

    ### 2. AD-HOC cut over the same resolved tables (no operation, just SQL)
        SO:0001587   n=3  avg_af=0.0002
        SO:0001575   n=1  avg_af=0.3
        SO:0001583   n=1  avg_af=0.0002

**What it proves:** the classification “skill” is a *tested SQL
operation* (`rare_high_impact.report`), not bespoke code; the abstention
(`allele_frequency IS NULL -> 'no_frequency'`, never `'rare'`) is
enforced in SQL and is the exact subtlety that earns a pinned, tested
spec; and the same declared data answers ad-hoc questions for free. Five
variants classify into five distinct buckets — one defensibly
*included*, one *abstained* on unknown frequency, one *benign*, one *not
rare*, one *not high-impact* — so the count an agent reports is the
defensible `included = 1`, not a naive `count(*)`. That is ClawBio’s
Variant Classification skill reproduced as the substrate’s data + SQL +
provenance, with the safety-critical edge case handled by construction.
The deterministic guarantee is the unit test for the operation; this
dogfood shows it answering real questions end to end.
