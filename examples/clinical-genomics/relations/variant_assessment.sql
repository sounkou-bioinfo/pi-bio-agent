SELECT
  v.case_id,
  v.variant_key,
  v.gene,
  v.consequence,
  TRY_CAST(v.allele_frequency AS DOUBLE) AS allele_frequency,
  v.clinical_significance,
  v.zygosity,
  v.inheritance,
  lof.id IS NOT NULL AS is_predicted_loss_of_function,
  CASE
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) IS NULL THEN 'abstain_no_frequency'
    WHEN lower(v.clinical_significance) = 'benign' THEN 'excluded_benign'
    WHEN lof.id IS NULL THEN 'excluded_not_high_impact'
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) >= 0.01 THEN 'excluded_not_rare'
    ELSE 'candidate'
  END AS variant_bucket,
  CASE
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) IS NULL THEN 'needs_frequency_evidence'
    WHEN lower(v.clinical_significance) = 'benign' THEN 'not_reportable_by_screen'
    WHEN lof.id IS NULL THEN 'not_reportable_by_screen'
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) >= 0.01 THEN 'not_reportable_by_screen'
    WHEN lower(v.clinical_significance) IN ('pathogenic', 'likely pathogenic') THEN 'curated_plp_candidate'
    ELSE 'candidate_needs_review'
  END AS variant_status,
  CASE
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) IS NULL THEN 'allele_frequency'
  END AS missing_field,
  CASE
    WHEN lower(v.clinical_significance) = 'benign' AND lof.id IS NOT NULL
      THEN 'benign_vs_predicted_loss_of_function'
  END AS conflict,
  CASE
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) IS NULL THEN 'resolve_frequency'
    WHEN lower(v.clinical_significance) = 'benign' AND lof.id IS NOT NULL THEN 'review_conflict'
    WHEN lower(v.clinical_significance) = 'benign' THEN NULL
    WHEN lof.id IS NULL THEN NULL
    WHEN TRY_CAST(v.allele_frequency AS DOUBLE) >= 0.01 THEN NULL
    WHEN lower(v.clinical_significance) IN ('pathogenic', 'likely pathogenic') THEN 'confirm_candidate'
    ELSE 'adjudicate_candidate'
  END AS review_kind
FROM case_variants v
LEFT JOIN so_loss_of_function lof
  ON lof.id = v.consequence
WHERE v.case_id = getvariable('case_id')
