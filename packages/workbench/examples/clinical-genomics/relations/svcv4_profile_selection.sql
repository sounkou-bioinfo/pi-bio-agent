-- Profile selection is deterministic and fail-closed. An explicitly requested
-- profile wins; otherwise the most specific gene/disease/MOI specialization
-- wins over baseline. Equal best candidates are reported as ambiguous.
WITH profiles AS (
  SELECT
    profile_id::VARCHAR AS profile_id,
    profile_version::VARCHAR AS profile_version,
    lower(profile_kind::VARCHAR) AS profile_kind,
    lower(profile_status::VARCHAR) AS profile_status,
    lower(classification_readiness::VARCHAR) AS classification_readiness,
    nullif(gene_id::VARCHAR, '') AS gene_id,
    nullif(disease_id::VARCHAR, '') AS disease_id,
    nullif(upper(moi::VARCHAR), '') AS moi,
    coalesce(try_cast(priority AS INTEGER), 0) AS priority,
    source_id::VARCHAR AS source_id
  FROM svcv4_profiles
), counted_scopes AS (
  SELECT
    s.*,
    count(*) OVER (PARTITION BY scope_id) AS scope_record_count,
    row_number() OVER (PARTITION BY scope_id ORDER BY scope_ordinal) AS scope_record_rank
  FROM svcv4_scopes s
), scope_validity_all AS (
  SELECT
    s.*,
    CASE
      WHEN coalesce(scope_id, '') = '' THEN 'missing_scope_id'
      WHEN scope_record_count > 1 THEN 'duplicate_scope_id'
      WHEN len(unknown_fields) > 0 THEN 'unknown_scope_fields'
      WHEN len(invalid_type_fields) > 0 OR invalid_method_code_type_count > 0 THEN 'invalid_scope_field_types'
      WHEN coalesce(variant_id, '') = '' THEN 'missing_variant_id'
      WHEN coalesce(disease_id, '') = '' THEN 'missing_disease_id'
      WHEN coalesce(moi, '') = '' THEN 'missing_moi'
      WHEN coalesce(evaluation_mode, '') = '' THEN 'missing_evaluation_mode'
      WHEN evaluation_mode NOT IN ('case_independent', 'case_conditioned') THEN 'invalid_evaluation_mode'
      WHEN evaluation_mode = 'case_conditioned' AND coalesce(case_id, '') = '' THEN 'missing_case_id'
      WHEN len(expected_method_codes) = 0 THEN 'missing_expected_method_codes'
      WHEN len(expected_method_codes) <> len(list_distinct(expected_method_codes)) THEN 'duplicate_expected_method_code'
      WHEN len(list_filter(expected_method_codes, method_code -> coalesce(method_code, '') = '')) > 0
        THEN 'empty_expected_method_code'
      WHEN requested_profile_version IS NOT NULL AND requested_profile_id IS NULL THEN 'profile_version_without_profile_id'
    END AS invalid_reason
  FROM counted_scopes s
), scope_validity AS (
  -- Collapse duplicate identifiers to one invalid audit row so downstream joins
  -- cannot multiply evidence or scores. scope_record_count preserves the defect.
  SELECT *
  FROM scope_validity_all
  WHERE scope_record_rank = 1
), candidates AS (
  -- Null specialization fields are wildcards. Specificity counts the number of
  -- constrained fields so a narrow profile outranks a broad specialization.
  SELECT
    s.scope_id,
    p.*,
    CASE
      WHEN s.requested_profile_id IS NOT NULL THEN 3
      WHEN p.profile_kind = 'specialized' THEN 2
      WHEN p.profile_kind = 'baseline' THEN 1
      ELSE 0
    END AS candidate_rank,
    (CASE WHEN p.gene_id IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.disease_id IS NOT NULL THEN 1 ELSE 0 END
      + CASE WHEN p.moi IS NOT NULL THEN 1 ELSE 0 END) AS specificity
  FROM scope_validity s
  JOIN profiles p
    ON s.invalid_reason IS NULL
   AND (
     (
       s.requested_profile_id IS NOT NULL
       AND p.profile_id = s.requested_profile_id
       AND (s.requested_profile_version IS NULL OR p.profile_version = s.requested_profile_version)
     )
     OR (
       s.requested_profile_id IS NULL
       AND p.profile_kind IN ('baseline', 'specialized')
     )
   )
   AND (p.gene_id IS NULL OR p.gene_id = s.gene_id)
   AND (p.disease_id IS NULL OR p.disease_id = s.disease_id)
   AND (p.moi IS NULL OR p.moi = s.moi)
), candidate_maxima AS (
  SELECT
    *,
    max(candidate_rank) OVER (PARTITION BY scope_id) AS best_rank
  FROM candidates
), specificity_maxima AS (
  SELECT
    *,
    max(CASE WHEN candidate_rank = best_rank THEN specificity END) OVER (PARTITION BY scope_id) AS best_specificity
  FROM candidate_maxima
), priority_maxima AS (
  SELECT
    *,
    max(CASE WHEN candidate_rank = best_rank AND specificity = best_specificity THEN priority END)
      OVER (PARTITION BY scope_id) AS best_priority
  FROM specificity_maxima
), finalists AS (
  -- Priority only breaks ties after profile kind and specificity. More than one
  -- finalist at the same priority remains an ambiguity rather than a lexical win.
  SELECT *
  FROM priority_maxima
  WHERE candidate_rank = best_rank
    AND specificity = best_specificity
    AND priority = best_priority
), finalist_counts AS (
  SELECT scope_id, count(*)::INTEGER AS finalist_count
  FROM finalists
  GROUP BY scope_id
), chosen AS (
  SELECT * EXCLUDE (choice_order)
  FROM (
    SELECT *, row_number() OVER (PARTITION BY scope_id ORDER BY profile_id, profile_version) AS choice_order
    FROM finalists
  )
  WHERE choice_order = 1
)
SELECT
  s.scope_id,
  s.scope_ordinal,
  s.scope_record_count,
  s.variant_id,
  s.gene_id,
  s.disease_id,
  s.moi,
  s.case_id,
  s.evaluation_mode,
  s.allow_provisional,
  s.expected_method_codes,
  s.unknown_fields AS scope_unknown_fields,
  s.invalid_type_fields AS scope_invalid_type_fields,
  s.invalid_method_code_type_count,
  s.requested_profile_id,
  s.requested_profile_version,
  c.profile_id,
  c.profile_version,
  c.profile_kind,
  c.profile_status,
  c.classification_readiness,
  c.source_id AS profile_source_id,
  coalesce(fc.finalist_count, 0) AS finalist_count,
  CASE
    WHEN s.invalid_reason IS NOT NULL THEN 'invalid_scope'
    WHEN s.requested_profile_id IS NOT NULL AND c.profile_id IS NULL THEN 'requested_profile_not_found_or_inapplicable'
    WHEN c.profile_id IS NULL THEN 'no_applicable_profile'
    WHEN fc.finalist_count > 1 THEN 'ambiguous_profile'
    WHEN c.profile_status = 'provisional' AND NOT s.allow_provisional THEN 'provisional_profile_not_allowed'
    WHEN c.profile_status NOT IN ('active', 'provisional') THEN 'profile_unavailable'
    ELSE 'selected'
  END AS selection_status,
  s.invalid_reason
FROM scope_validity s
LEFT JOIN chosen c USING (scope_id)
LEFT JOIN finalist_counts fc USING (scope_id)
