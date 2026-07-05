WITH observed AS (
  SELECT
    case_id,
    hpo_id
  FROM case_hpo
  WHERE case_id = getvariable('case_id')
    AND status = 'observed'
),
gene_score AS (
  SELECT
    o.case_id,
    gp.gene,
    gp.disease_id,
    gp.validity,
    gp.mode,
    COUNT(*)::INTEGER AS phenotype_score
  FROM observed o
  JOIN gene_phenotype gp USING (hpo_id)
  GROUP BY
    o.case_id,
    gp.gene,
    gp.disease_id,
    gp.validity,
    gp.mode
),
variant_buckets AS (
  SELECT
    case_id,
    variant_key,
    gene,
    consequence,
    TRY_CAST(allele_frequency AS DOUBLE) AS allele_frequency,
    clinical_significance,
    CASE
      WHEN TRY_CAST(allele_frequency AS DOUBLE) IS NULL THEN 'abstain_no_frequency'
      WHEN lower(clinical_significance) = 'benign' THEN 'excluded_benign'
      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'excluded_not_high_impact'
      WHEN TRY_CAST(allele_frequency AS DOUBLE) >= 0.01 THEN 'excluded_not_rare'
      ELSE 'candidate'
    END AS direct_bucket
  FROM case_variants
  WHERE case_id = getvariable('case_id')
),
ranked_variants AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY case_id, gene
      ORDER BY
        CASE direct_bucket
          WHEN 'candidate' THEN 0
          WHEN 'abstain_no_frequency' THEN 1
          ELSE 2
        END,
        variant_key
    ) AS rn
  FROM variant_buckets
)
SELECT
  gs.case_id,
  gs.gene,
  gs.disease_id,
  gs.validity,
  gs.mode,
  gs.phenotype_score,
  rv.variant_key,
  rv.consequence,
  rv.allele_frequency,
  rv.clinical_significance,
  rv.direct_bucket,
  CASE
    WHEN rv.variant_key IS NULL THEN 'hypothesis_without_variant'
    WHEN rv.direct_bucket = 'candidate' THEN 'genotype_supports_hypothesis'
    WHEN rv.direct_bucket = 'abstain_no_frequency' THEN 'hypothesis_variant_abstained'
    ELSE 'variant_does_not_support_hypothesis'
  END AS hypothesis_bucket
FROM gene_score gs
LEFT JOIN ranked_variants rv
  ON rv.case_id = gs.case_id
 AND rv.gene = gs.gene
 AND rv.rn = 1
ORDER BY
  gs.phenotype_score DESC,
  CASE hypothesis_bucket
    WHEN 'genotype_supports_hypothesis' THEN 0
    WHEN 'hypothesis_variant_abstained' THEN 1
    WHEN 'hypothesis_without_variant' THEN 2
    ELSE 3
  END,
  gs.gene
