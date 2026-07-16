-- Audit exactly one method-result line per expected evidence code. Method
-- evaluators may consume many cases/items internally, but their scored roll-up
-- crosses this boundary once so duplicate counting is detectable.
WITH expected_methods AS (
  SELECT DISTINCT
    p.*,
    method_code
  FROM svcv4_profile_selection p,
  unnest(p.expected_method_codes) AS methods(method_code)
), line_counts AS (
  SELECT scope_id, method_code, count(*)::INTEGER AS line_count
  FROM svcv4_evidence_lines
  GROUP BY scope_id, method_code
), line_id_counts AS (
  SELECT line_id, count(*)::INTEGER AS line_id_count
  FROM svcv4_evidence_lines
  GROUP BY line_id
), ranked_lines AS (
  SELECT
    l.*,
    row_number() OVER (PARTITION BY scope_id, method_code ORDER BY line_id) AS method_line_rank
  FROM svcv4_evidence_lines l
), policy_any AS (
  -- Evaluator policy is profile-specific. A method named in the draft is not
  -- executable merely because an input row claims to have scored it.
  SELECT profile_id, profile_version, method_code, count(*)::INTEGER AS policy_count
  FROM svcv4_evaluator_policy
  WHERE policy_status = 'active'
  GROUP BY profile_id, profile_version, method_code
), expected_with_line AS (
  SELECT
    e.*,
    coalesce(c.line_count, 0) AS line_count,
    l.line_id,
    l.variant_id AS line_variant_id,
    l.gene_id AS line_gene_id,
    l.disease_id AS line_disease_id,
    l.moi AS line_moi,
    l.case_id AS line_case_id,
    l.profile_id AS line_profile_id,
    l.profile_version AS line_profile_version,
    l.evaluation_state,
    l.score,
    l.reason_code,
    l.evidence_item_ids,
    l.evaluator_id,
    l.evaluator_version,
    l.method_definition_digest,
    l.producer_run_id,
    l.producer_result_digest,
    l.admission_state,
    l.branch_group,
    l.branch_id,
    coalesce(idc.line_id_count, 0) AS line_id_count,
    n.parent_node_code,
    try_cast(n.min_score AS DOUBLE) AS method_min_score,
    try_cast(n.max_score AS DOUBLE) AS method_max_score,
    n.evaluation_scope AS method_evaluation_scope,
    n.implementation_status,
    nullif(n.exclusive_group::VARCHAR, '') AS configured_exclusive_group,
    coalesce(try_cast(n.branch_required AS BOOLEAN), false) AS branch_required,
    coalesce(pa.policy_count, 0) AS active_policy_count,
    CASE WHEN pm.evaluator_id IS NULL THEN false ELSE true END AS evaluator_policy_matched
  FROM expected_methods e
  LEFT JOIN line_counts c USING (scope_id, method_code)
  LEFT JOIN ranked_lines l
    ON l.scope_id = e.scope_id
   AND l.method_code = e.method_code
   AND l.method_line_rank = 1
  LEFT JOIN line_id_counts idc ON idc.line_id = l.line_id
  LEFT JOIN svcv4_score_nodes n
    ON n.profile_id = e.profile_id
   AND n.profile_version = e.profile_version
   AND n.node_stage = 0
   AND n.node_code = e.method_code
  LEFT JOIN policy_any pa
    ON pa.profile_id = e.profile_id
   AND pa.profile_version = e.profile_version
   AND pa.method_code = e.method_code
  LEFT JOIN svcv4_evaluator_policy pm
    ON pm.profile_id = e.profile_id
   AND pm.profile_version = e.profile_version
   AND pm.method_code = e.method_code
   AND pm.evaluator_id = l.evaluator_id
   AND pm.evaluator_version = l.evaluator_version
   AND pm.method_definition_digest = l.method_definition_digest
   AND pm.policy_status = 'active'
), expected_audit AS (
  SELECT
    scope_id,
    variant_id,
    gene_id,
    disease_id,
    moi,
    case_id,
    evaluation_mode,
    profile_id,
    profile_version,
    profile_status,
    selection_status,
    method_code,
    true AS is_expected,
    line_id,
    evaluation_state,
    score,
    reason_code,
    evidence_item_ids,
    evaluator_id,
    evaluator_version,
    method_definition_digest,
    producer_run_id,
    producer_result_digest,
    branch_group,
    branch_id,
    parent_node_code,
    method_min_score,
    method_max_score,
    method_evaluation_scope,
    implementation_status,
    configured_exclusive_group,
    branch_required,
    CASE
      -- Keep profile/method coverage failures separate from malformed evidence.
      -- Both prevent a final class, but they drive different review actions.
      WHEN selection_status <> 'selected' THEN 'incomplete'
      WHEN implementation_status = 'underspecified' THEN 'incomplete'
      WHEN parent_node_code IS NULL THEN 'invalid'
      WHEN line_count = 0 AND active_policy_count = 0 THEN 'incomplete'
      WHEN line_count = 0 THEN 'incomplete'
      WHEN line_count > 1 THEN 'invalid'
      WHEN line_id_count > 1 THEN 'invalid'
      WHEN coalesce(line_id, '') = '' THEN 'invalid'
      WHEN line_variant_id <> variant_id
        OR line_disease_id <> disease_id
        OR line_moi <> moi
        OR (gene_id IS NOT NULL AND line_gene_id IS DISTINCT FROM gene_id)
        OR (case_id IS NOT NULL AND line_case_id IS DISTINCT FROM case_id) THEN 'invalid'
      WHEN line_profile_id <> profile_id OR line_profile_version <> profile_version THEN 'invalid'
      WHEN admission_state <> 'accepted' THEN 'invalid'
      WHEN NOT evaluator_policy_matched THEN 'invalid'
      WHEN coalesce(producer_run_id, '') = ''
        OR NOT regexp_matches(coalesce(producer_result_digest, ''), '^sha256:[0-9a-f]{64}$') THEN 'invalid'
      WHEN evaluation_mode = 'case_independent' AND method_evaluation_scope <> 'case_independent' THEN 'invalid'
      WHEN evaluation_state NOT IN ('scored', 'no_evidence', 'not_applicable', 'not_evaluated') THEN 'invalid'
      WHEN evaluation_state = 'scored' AND (score IS NULL OR NOT isfinite(score)) THEN 'invalid'
      WHEN evaluation_state = 'scored' AND method_min_score IS NOT NULL AND score < method_min_score THEN 'invalid'
      WHEN evaluation_state = 'scored' AND method_max_score IS NOT NULL AND score > method_max_score THEN 'invalid'
      -- A zero score is still a score. Keep it distinct from no evidence,
      -- not-applicable, and not-evaluated states by requiring NULL here; the
      -- roll-up derives the internal zero contribution for no_evidence only
      -- after this audit succeeds.
      WHEN evaluation_state <> 'scored' AND score IS NOT NULL THEN 'invalid'
      WHEN evaluation_state IN ('scored', 'no_evidence') AND len(evidence_item_ids) = 0 THEN 'invalid'
      WHEN evaluation_state <> 'scored' AND coalesce(reason_code, '') = '' THEN 'invalid'
      WHEN evaluation_state IN ('scored', 'no_evidence') AND branch_required
        AND (branch_group IS DISTINCT FROM configured_exclusive_group OR coalesce(branch_id, '') = '') THEN 'invalid'
      WHEN NOT branch_required AND (branch_group IS NOT NULL OR branch_id IS NOT NULL) THEN 'invalid'
      WHEN evaluation_state = 'not_evaluated' THEN 'incomplete'
      ELSE 'complete'
    END AS audit_status,
    CASE
      WHEN selection_status <> 'selected' THEN selection_status
      WHEN implementation_status = 'underspecified' THEN 'method_underspecified'
      WHEN parent_node_code IS NULL THEN 'method_not_configured'
      WHEN line_count = 0 AND active_policy_count = 0 THEN 'evaluator_not_configured'
      WHEN line_count = 0 THEN 'missing_method_result'
      WHEN line_count > 1 THEN 'multiple_method_results'
      WHEN line_id_count > 1 THEN 'duplicate_line_id'
      WHEN coalesce(line_id, '') = '' THEN 'missing_line_id'
      WHEN line_variant_id <> variant_id
        OR line_disease_id <> disease_id
        OR line_moi <> moi
        OR (gene_id IS NOT NULL AND line_gene_id IS DISTINCT FROM gene_id)
        OR (case_id IS NOT NULL AND line_case_id IS DISTINCT FROM case_id) THEN 'scope_identity_mismatch'
      WHEN line_profile_id <> profile_id OR line_profile_version <> profile_version THEN 'profile_identity_mismatch'
      WHEN admission_state <> 'accepted' THEN 'line_not_admitted'
      WHEN NOT evaluator_policy_matched THEN 'evaluator_identity_not_approved'
      WHEN coalesce(producer_run_id, '') = '' THEN 'missing_producer_run'
      WHEN NOT regexp_matches(coalesce(producer_result_digest, ''), '^sha256:[0-9a-f]{64}$') THEN 'invalid_producer_result_digest'
      WHEN evaluation_mode = 'case_independent' AND method_evaluation_scope <> 'case_independent' THEN 'method_requires_case_context'
      WHEN evaluation_state NOT IN ('scored', 'no_evidence', 'not_applicable', 'not_evaluated') THEN 'invalid_evaluation_state'
      WHEN evaluation_state = 'scored' AND (score IS NULL OR NOT isfinite(score)) THEN 'invalid_score'
      WHEN evaluation_state = 'scored' AND method_min_score IS NOT NULL AND score < method_min_score
        THEN 'score_below_configured_minimum'
      WHEN evaluation_state = 'scored' AND method_max_score IS NOT NULL AND score > method_max_score
        THEN 'score_above_configured_maximum'
      WHEN evaluation_state <> 'scored' AND score IS NOT NULL THEN 'score_on_unscored_line'
      WHEN evaluation_state IN ('scored', 'no_evidence') AND len(evidence_item_ids) = 0
        THEN 'evidence_line_without_evidence_items'
      WHEN evaluation_state <> 'scored' AND coalesce(reason_code, '') = '' THEN 'unscored_line_without_reason'
      WHEN evaluation_state IN ('scored', 'no_evidence') AND branch_required
        AND (branch_group IS DISTINCT FROM configured_exclusive_group OR coalesce(branch_id, '') = '') THEN 'missing_or_invalid_branch_identity'
      WHEN NOT branch_required AND (branch_group IS NOT NULL OR branch_id IS NOT NULL) THEN 'unexpected_branch_identity'
      WHEN evaluation_state = 'not_evaluated' THEN coalesce(reason_code, 'method_not_evaluated')
      ELSE coalesce(reason_code, evaluation_state)
    END AS audit_reason,
    CASE
      WHEN evaluation_state = 'scored' THEN score
      WHEN evaluation_state = 'no_evidence' THEN 0::DOUBLE
    END AS effective_score
  FROM expected_with_line
), unexpected_audit AS (
  -- Extra method rows are invalid rather than silently ignored; otherwise a
  -- caller could alter the score without declaring the method in the scope.
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
    p.selection_status,
    l.method_code,
    false AS is_expected,
    l.line_id,
    l.evaluation_state,
    l.score,
    l.reason_code,
    l.evidence_item_ids,
    l.evaluator_id,
    l.evaluator_version,
    l.method_definition_digest,
    l.producer_run_id,
    l.producer_result_digest,
    l.branch_group,
    l.branch_id,
    NULL::VARCHAR AS parent_node_code,
    NULL::DOUBLE AS method_min_score,
    NULL::DOUBLE AS method_max_score,
    NULL::VARCHAR AS method_evaluation_scope,
    NULL::VARCHAR AS implementation_status,
    NULL::VARCHAR AS configured_exclusive_group,
    false AS branch_required,
    'invalid' AS audit_status,
    'unexpected_method_result' AS audit_reason,
    NULL::DOUBLE AS effective_score
  FROM svcv4_evidence_lines l
  LEFT JOIN svcv4_profile_selection p USING (scope_id)
  WHERE p.scope_id IS NULL
     OR NOT list_contains(p.expected_method_codes, l.method_code)
)
SELECT * FROM expected_audit
UNION ALL BY NAME
SELECT * FROM unexpected_audit
