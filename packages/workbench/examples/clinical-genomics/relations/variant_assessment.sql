WITH enriched AS (
  SELECT
    v.*,
    va.impact AS annotation_impact,
    va.consequence AS annotation_consequence,
    va.allele_frequency AS annotation_allele_frequency,
    va.clinical_significance AS annotation_clinical_significance,
    coalesce(va.consequence, v.consequence) AS assessed_consequence,
    coalesce(va.allele_frequency, TRY_CAST(v.allele_frequency AS DOUBLE)) AS assessed_allele_frequency,
    coalesce(va.clinical_significance, v.clinical_significance) AS assessed_clinical_significance
  FROM variant_inputs v
  LEFT JOIN variant_annotations va
    ON va.variant_key = v.variant_key
   AND (va.gene IS NULL OR va.gene = v.gene)
)
SELECT
  v.variant_source,
  v.case_id,
  v.selection_gene_id,
  v.selection_disease_ids,
  v.hypothesis_rank,
  v.variant_key,
  v.gene,
  v.annotated_gene,
  v.assessed_consequence AS consequence,
  v.assessed_allele_frequency AS allele_frequency,
  v.assessed_clinical_significance AS clinical_significance,
  v.annotation_impact,
  v.annotation_consequence,
  v.annotation_allele_frequency,
  v.annotation_clinical_significance,
  v.zygosity,
  v.inheritance,
  lof.id IS NOT NULL AS is_predicted_loss_of_function,
  CASE
    WHEN v.assessed_allele_frequency IS NULL THEN 'abstain_no_frequency'
    WHEN lower(v.assessed_clinical_significance) = 'benign' THEN 'excluded_benign'
    WHEN lof.id IS NULL THEN 'excluded_not_high_impact'
    WHEN v.assessed_allele_frequency >= 0.01 THEN 'excluded_not_rare'
    ELSE 'candidate'
  END AS variant_bucket,
  CASE
    WHEN v.assessed_allele_frequency IS NULL THEN 'needs_frequency_evidence'
    WHEN lower(v.assessed_clinical_significance) = 'benign' THEN 'not_reportable_by_screen'
    WHEN lof.id IS NULL THEN 'not_reportable_by_screen'
    WHEN v.assessed_allele_frequency >= 0.01 THEN 'not_reportable_by_screen'
    WHEN lower(v.assessed_clinical_significance) IN ('pathogenic', 'likely pathogenic') THEN 'curated_plp_candidate'
    ELSE 'candidate_needs_review'
  END AS variant_status,
  CASE
    WHEN v.assessed_allele_frequency IS NULL THEN 'allele_frequency'
  END AS missing_field,
  CASE
    WHEN lower(v.assessed_clinical_significance) = 'benign' AND lof.id IS NOT NULL
      THEN 'benign_vs_predicted_loss_of_function'
  END AS conflict,
  CASE
    WHEN v.assessed_allele_frequency IS NULL THEN 'resolve_frequency'
    WHEN lower(v.assessed_clinical_significance) = 'benign' AND lof.id IS NOT NULL THEN 'review_conflict'
    WHEN lower(v.assessed_clinical_significance) = 'benign' THEN NULL
    WHEN lof.id IS NULL THEN NULL
    WHEN v.assessed_allele_frequency >= 0.01 THEN NULL
    WHEN lower(v.assessed_clinical_significance) IN ('pathogenic', 'likely pathogenic') THEN 'confirm_candidate'
    ELSE 'adjudicate_candidate'
  END AS review_kind
FROM enriched v
LEFT JOIN so_loss_of_function lof
  ON lof.id = v.assessed_consequence
WHERE v.case_id = getvariable('case_id')
