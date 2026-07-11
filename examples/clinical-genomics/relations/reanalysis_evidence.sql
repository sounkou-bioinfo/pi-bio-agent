WITH current_and_prior AS (
  SELECT
    coalesce(current.case_id, prior.case_id) AS case_id,
    coalesce(current.variant_key, prior.variant_key) AS variant_key,
    prior.prior_status,
    current.variant_status AS current_status
  FROM (SELECT * FROM variant_assessment WHERE variant_source = 'direct') current
  FULL OUTER JOIN prior_assessment prior USING (case_id, variant_key)
  WHERE coalesce(current.case_id, prior.case_id) = getvariable('case_id')
)
SELECT
  cp.case_id,
  cp.variant_key,
  cp.prior_status,
  cp.current_status,
  CASE
    WHEN cp.prior_status IS NULL THEN 'new'
    WHEN cp.current_status IS NULL THEN 'dropped'
    WHEN prior_order.rank IS NULL OR current_order.rank IS NULL THEN 'abstain_unknown_status'
    WHEN cp.prior_status = cp.current_status THEN 'unchanged'
    WHEN current_order.rank > prior_order.rank THEN 'upgraded'
    ELSE 'downgraded'
  END AS change_status
FROM current_and_prior cp
LEFT JOIN assessment_status_order prior_order
  ON prior_order.status = cp.prior_status
LEFT JOIN assessment_status_order current_order
  ON current_order.status = cp.current_status
WHERE cp.prior_status IS NOT NULL
   OR cp.current_status IN ('needs_frequency_evidence', 'candidate_needs_review', 'curated_plp_candidate')
