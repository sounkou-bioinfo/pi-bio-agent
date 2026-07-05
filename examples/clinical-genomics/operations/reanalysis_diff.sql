WITH current AS (
  SELECT
    case_id,
    variant_key,
    CASE
      WHEN TRY_CAST(allele_frequency AS DOUBLE) IS NULL THEN 'needs_frequency_evidence'
      WHEN lower(clinical_significance) = 'benign' THEN 'not_reportable_by_screen'
      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_reportable_by_screen'
      WHEN TRY_CAST(allele_frequency AS DOUBLE) >= 0.01 THEN 'not_reportable_by_screen'
      WHEN clinical_significance IN ('Pathogenic', 'Likely Pathogenic') THEN 'curated_plp_candidate'
      ELSE 'candidate_needs_review'
    END AS current_status
  FROM case_variants
  WHERE case_id = getvariable('case_id')
),
prior AS (
  SELECT
    case_id,
    variant_key,
    prior_status
  FROM prior_assessment
  WHERE case_id = getvariable('case_id')
),
both_sides AS (
  SELECT
    COALESCE(c.case_id, p.case_id) AS case_id,
    COALESCE(c.variant_key, p.variant_key) AS variant_key,
    p.prior_status,
    c.current_status
  FROM current c
  FULL OUTER JOIN prior p USING (case_id, variant_key)
),
ranked AS (
  SELECT
    *,
    CASE prior_status
      WHEN 'not_reportable_by_screen' THEN 0
      WHEN 'needs_frequency_evidence' THEN 1
      WHEN 'candidate_needs_review' THEN 2
      WHEN 'curated_plp_candidate' THEN 3
      WHEN 'confirmed' THEN 4
      ELSE -1
    END AS prior_rank,
    CASE current_status
      WHEN 'not_reportable_by_screen' THEN 0
      WHEN 'needs_frequency_evidence' THEN 1
      WHEN 'candidate_needs_review' THEN 2
      WHEN 'curated_plp_candidate' THEN 3
      WHEN 'confirmed' THEN 4
      ELSE -1
    END AS current_rank
  FROM both_sides
)
SELECT
  case_id,
  variant_key,
  prior_status,
  current_status,
  CASE
    WHEN prior_status IS NULL THEN 'new'
    WHEN current_status IS NULL THEN 'dropped'
    WHEN current_rank > prior_rank THEN 'upgraded'
    WHEN current_rank < prior_rank THEN 'downgraded'
    ELSE 'unchanged'
  END AS status
FROM ranked
ORDER BY
  CASE status
    WHEN 'upgraded' THEN 0
    WHEN 'new' THEN 1
    WHEN 'downgraded' THEN 2
    WHEN 'dropped' THEN 3
    ELSE 4
  END,
  variant_key
