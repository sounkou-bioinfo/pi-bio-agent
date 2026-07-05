WITH classified AS (
  SELECT
    case_id,
    variant_key,
    gene,
    consequence,
    TRY_CAST(allele_frequency AS DOUBLE) AS allele_frequency,
    clinical_significance,
    zygosity,
    inheritance,
    CASE
      WHEN TRY_CAST(allele_frequency AS DOUBLE) IS NULL THEN 'abstain_no_frequency'
      WHEN lower(clinical_significance) = 'benign' THEN 'excluded_benign'
      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'excluded_not_high_impact'
      WHEN TRY_CAST(allele_frequency AS DOUBLE) >= 0.01 THEN 'excluded_not_rare'
      ELSE 'candidate'
    END AS bucket
  FROM case_variants
  WHERE case_id = getvariable('case_id')
)
SELECT
  *,
  CASE
    WHEN bucket = 'candidate' AND clinical_significance IN ('Pathogenic', 'Likely Pathogenic') THEN 'curated_plp_candidate'
    WHEN bucket = 'candidate' THEN 'candidate_needs_review'
    WHEN bucket = 'abstain_no_frequency' THEN 'needs_frequency_evidence'
    ELSE 'not_reportable_by_screen'
  END AS evidence_status
FROM classified
ORDER BY
  CASE bucket
    WHEN 'candidate' THEN 0
    WHEN 'abstain_no_frequency' THEN 1
    ELSE 2
  END,
  gene,
  variant_key
