-- A numeric score is not a classification until profile selection, expected
-- method coverage, line validation, and every configured roll-up have succeeded.
WITH scope_checks AS (
  SELECT
    p.*,
    len(p.expected_method_codes) AS configured_method_count,
    len(list_distinct(p.expected_method_codes)) AS distinct_method_count
  FROM svcv4_profile_selection p
), audit_summary AS (
  SELECT
    scope_id,
    count(*) FILTER (WHERE is_expected)::INTEGER AS audited_method_count,
    count(*) FILTER (WHERE is_expected AND audit_status = 'complete')::INTEGER AS complete_method_count,
    count(*) FILTER (WHERE audit_status = 'incomplete')::INTEGER AS incomplete_count,
    count(*) FILTER (WHERE audit_status = 'invalid')::INTEGER AS invalid_count,
    coalesce(list_sort(list_distinct(list(method_code) FILTER (WHERE audit_status = 'incomplete'))), []::VARCHAR[]) AS incomplete_method_codes,
    coalesce(list_sort(list_distinct(list(method_code) FILTER (WHERE audit_status = 'invalid'))), []::VARCHAR[]) AS invalid_method_codes,
    coalesce(list_sort(list_distinct(list(audit_reason) FILTER (WHERE audit_status <> 'complete'))), []::VARCHAR[]) AS audit_reasons
  FROM svcv4_line_audit
  GROUP BY scope_id
), final_scores AS (
  SELECT scope_id, capped_score AS rollup_score
  FROM svcv4_score_rollup
  WHERE node_stage = 5 AND node_code = 'FINAL'
), selected_branches AS (
  SELECT
    scope_id,
    coalesce(list_sort(list_distinct(list(branch_group || ':' || branch_id) FILTER (WHERE branch_group IS NOT NULL))), []::VARCHAR[]) AS selected_branches
  FROM svcv4_score_rollup
  WHERE node_stage = 0
  GROUP BY scope_id
), preliminary AS (
  SELECT
    s.*,
    coalesce(a.audited_method_count, 0) AS audited_method_count,
    coalesce(a.complete_method_count, 0) AS complete_method_count,
    coalesce(a.incomplete_count, 0) AS incomplete_count,
    coalesce(a.invalid_count, 0) AS invalid_count,
    coalesce(a.incomplete_method_codes, []::VARCHAR[]) AS incomplete_method_codes,
    coalesce(a.invalid_method_codes, []::VARCHAR[]) AS invalid_method_codes,
    coalesce(a.audit_reasons, []::VARCHAR[]) AS audit_reasons,
    coalesce(b.selected_branches, []::VARCHAR[]) AS selected_branches,
    coalesce(f.rollup_score, 0::DOUBLE) AS candidate_score,
    CASE
      -- Missing/unsupported methods abstain; malformed or undeclared lines are
      -- invalid evidence. Neither state is converted into a zero contribution.
      WHEN s.selection_status <> 'selected' THEN s.selection_status
      WHEN s.classification_readiness <> 'clinical_classification' THEN 'profile_not_ready_for_classification'
      WHEN s.configured_method_count = 0 THEN 'invalid_scope'
      WHEN s.configured_method_count <> s.distinct_method_count THEN 'invalid_scope'
      WHEN coalesce(a.invalid_count, 0) > 0 THEN 'invalid_evidence'
      WHEN coalesce(a.incomplete_count, 0) > 0 OR coalesce(a.audited_method_count, 0) <> s.distinct_method_count THEN 'incomplete'
      ELSE 'classification_pending_band'
    END AS preliminary_status
  FROM scope_checks s
  LEFT JOIN audit_summary a USING (scope_id)
  LEFT JOIN final_scores f USING (scope_id)
  LEFT JOIN selected_branches b USING (scope_id)
), band_matches AS (
  -- Band endpoints are profile data. Half-point totals therefore follow the
  -- same continuous intervals instead of being rounded in code.
  SELECT
    p.scope_id,
    b.band_id,
    b.classification,
    nullif(b.uncertainty_band::VARCHAR, '') AS uncertainty_band,
    row_number() OVER (PARTITION BY p.scope_id ORDER BY try_cast(b.sort_order AS INTEGER)) AS band_rank
  FROM preliminary p
  JOIN svcv4_classification_bands b
    ON b.profile_id = p.profile_id
   AND b.profile_version = p.profile_version
   AND p.preliminary_status = 'classification_pending_band'
   AND (
     nullif(b.lower_bound::VARCHAR, '') IS NULL
     OR CASE WHEN try_cast(b.lower_inclusive AS BOOLEAN)
       THEN p.candidate_score >= try_cast(b.lower_bound AS DOUBLE)
       ELSE p.candidate_score > try_cast(b.lower_bound AS DOUBLE)
     END
   )
   AND (
     nullif(b.upper_bound::VARCHAR, '') IS NULL
     OR CASE WHEN try_cast(b.upper_inclusive AS BOOLEAN)
       THEN p.candidate_score <= try_cast(b.upper_bound AS DOUBLE)
       ELSE p.candidate_score < try_cast(b.upper_bound AS DOUBLE)
     END
   )
), selected_band AS (
  SELECT * FROM band_matches WHERE band_rank = 1
)
SELECT
  p.scope_id,
  p.variant_id,
  p.gene_id,
  p.disease_id,
  p.moi,
  p.case_id,
  p.evaluation_mode,
  p.profile_id,
  p.profile_version,
  p.profile_status,
  p.classification_readiness,
  p.selection_status AS profile_selection_status,
  p.configured_method_count AS expected_method_count,
  p.complete_method_count,
  p.incomplete_method_codes,
  p.invalid_method_codes,
  p.audit_reasons,
  p.selected_branches,
  CASE WHEN p.preliminary_status = 'classification_pending_band' AND b.band_id IS NOT NULL THEN p.candidate_score END AS final_score,
  CASE WHEN p.preliminary_status = 'classification_pending_band' AND b.band_id IS NOT NULL THEN b.classification END AS classification,
  CASE WHEN p.preliminary_status = 'classification_pending_band' AND b.band_id IS NOT NULL THEN b.uncertainty_band END AS uncertainty_band,
  CASE
    WHEN p.preliminary_status = 'classification_pending_band' AND b.band_id IS NOT NULL THEN 'classified'
    WHEN p.preliminary_status = 'classification_pending_band' THEN 'classification_band_gap'
    ELSE p.preliminary_status
  END AS classification_status,
  src.source_uri AS profile_source_uri,
  src.source_version AS profile_source_version,
  src.source_digest AS profile_source_digest,
  src.source_status AS profile_source_status
FROM preliminary p
LEFT JOIN selected_band b USING (scope_id)
LEFT JOIN svcv4_sources src ON src.source_id = p.profile_source_id
ORDER BY p.scope_id
