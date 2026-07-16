-- Form exact VBC-MDE scopes from a checkpointed candidate-search result and
-- separately admitted gene-disease-MOI knowledge. Every candidate/disease path
-- produces either a reusable case-independent POP_FRQ scope or an explicit
-- reason why no scope was formed.
WITH item_counts AS (
  SELECT item_id, count(*)::INTEGER AS item_id_count
  FROM svcv4_disease_model_observations
  WHERE item_id IS NOT NULL
  GROUP BY item_id
), candidates AS (
  SELECT
    c.*,
    CASE
      WHEN len(c.invalid_type_fields) > 0 THEN 'invalid_candidate_field_types'
      WHEN c.record_kind IS DISTINCT FROM 'variant' THEN 'candidate_is_not_variant_row'
      WHEN c.case_id IS DISTINCT FROM getvariable('case_id')::VARCHAR THEN 'candidate_case_identity_mismatch'
      WHEN coalesce(c.candidate_run_id, '') = '' THEN 'missing_candidate_run_id'
      WHEN NOT regexp_matches(coalesce(c.candidate_result_digest, ''), '^sha256:[0-9a-f]{64}$')
        THEN 'invalid_candidate_result_digest'
      WHEN coalesce(c.variant_id, '') = '' THEN 'missing_exact_variant_identity'
      WHEN coalesce(c.gene_id, '') = '' THEN 'missing_candidate_gene_id'
      WHEN len(coalesce(c.disease_ids, []::VARCHAR[])) = 0 THEN 'missing_candidate_disease_ids'
      WHEN c.search_status IS DISTINCT FROM 'completed' THEN 'candidate_search_not_completed'
    END AS candidate_error
  FROM svcv4_scope_candidates c
), candidate_diseases AS (
  SELECT c.*, disease.disease_id
  FROM candidates c
  LEFT JOIN UNNEST(coalesce(c.disease_ids, []::VARCHAR[])) disease(disease_id) ON true
), joined AS (
  SELECT
    c.*,
    d.observation_ordinal,
    d.item_id AS disease_model_item_id,
    d.moi,
    d.admission_state,
    d.source_id,
    d.source_version,
    d.source_uri,
    d.source_digest,
    d.observed_at,
    d.unknown_fields AS disease_model_unknown_fields,
    d.invalid_type_fields AS disease_model_invalid_type_fields,
    coalesce(ic.item_id_count, 0) AS disease_model_item_id_count,
    CASE
      WHEN c.candidate_error IS NOT NULL THEN c.candidate_error
      WHEN coalesce(c.disease_id, '') = '' THEN 'missing_candidate_disease_id'
      WHEN d.observation_ordinal IS NULL THEN 'disease_model_evidence_missing'
      WHEN coalesce(d.item_id, '') = '' THEN 'missing_disease_model_item_id'
      WHEN coalesce(ic.item_id_count, 0) > 1 THEN 'duplicate_disease_model_item_id'
      WHEN len(d.unknown_fields) > 0 THEN 'unknown_disease_model_fields'
      WHEN len(d.invalid_type_fields) > 0 THEN 'invalid_disease_model_field_types'
      WHEN d.admission_state <> 'accepted' THEN 'disease_model_evidence_not_admitted'
      WHEN coalesce(d.moi, '') = '' THEN 'missing_disease_model_moi'
      WHEN coalesce(d.source_id, '') = '' OR coalesce(d.source_version, '') = ''
        OR coalesce(d.source_uri, '') = '' OR coalesce(d.observed_at, '') = ''
        OR NOT regexp_matches(coalesce(d.source_digest, ''), '^sha256:[0-9a-f]{64}$')
        THEN 'incomplete_disease_model_source_identity'
      WHEN try_cast(d.observed_at AS TIMESTAMPTZ) IS NULL THEN 'invalid_disease_model_observed_at'
    END AS formation_error
  FROM candidate_diseases c
  LEFT JOIN svcv4_disease_model_observations d
    ON c.candidate_error IS NULL
   AND d.gene_id = c.gene_id
   AND d.disease_id = c.disease_id
  LEFT JOIN item_counts ic ON ic.item_id = d.item_id
), valid_groups AS (
  SELECT
    variant_id,
    variant_identifier_scheme,
    gene_id,
    disease_id,
    moi,
    min(hypothesis_rank)::INTEGER AS hypothesis_rank,
    list_sort(list_distinct(list(candidate_record_digest))) AS candidate_record_digests,
    list_sort(list_distinct(list(disease_model_item_id))) AS disease_model_item_ids,
    any_value(candidate_run_id) AS candidate_run_id,
    any_value(candidate_result_digest) AS candidate_result_digest
  FROM joined
  WHERE formation_error IS NULL
  GROUP BY variant_id, variant_identifier_scheme, gene_id, disease_id, moi
), formed AS (
  SELECT
    'svcv4:' || sha256(CAST(to_json(struct_pack(
      variant_id := variant_id,
      gene_id := gene_id,
      disease_id := disease_id,
      moi := moi,
      evaluation_mode := 'case_independent'
    )) AS VARCHAR)) AS scope_id,
    variant_id,
    variant_identifier_scheme,
    gene_id,
    disease_id,
    moi,
    NULL::VARCHAR AS case_id,
    'case_independent'::VARCHAR AS evaluation_mode,
    getvariable('svcv4_allow_provisional')::BOOLEAN AS allow_provisional,
    ['POP_FRQ']::VARCHAR[] AS expected_method_codes,
    hypothesis_rank,
    candidate_run_id,
    candidate_result_digest,
    candidate_record_digests,
    disease_model_item_ids,
    'formed'::VARCHAR AS formation_state,
    NULL::VARCHAR AS reason_code
  FROM valid_groups
), failed AS (
  SELECT
    NULL::VARCHAR AS scope_id,
    variant_id,
    variant_identifier_scheme,
    gene_id,
    disease_id,
    moi,
    case_id,
    'case_independent'::VARCHAR AS evaluation_mode,
    getvariable('svcv4_allow_provisional')::BOOLEAN AS allow_provisional,
    ['POP_FRQ']::VARCHAR[] AS expected_method_codes,
    hypothesis_rank,
    candidate_run_id,
    candidate_result_digest,
    [candidate_record_digest]::VARCHAR[] AS candidate_record_digests,
    CASE WHEN disease_model_item_id IS NULL THEN []::VARCHAR[] ELSE [disease_model_item_id]::VARCHAR[] END
      AS disease_model_item_ids,
    'not_formed'::VARCHAR AS formation_state,
    formation_error AS reason_code
  FROM joined
  WHERE formation_error IS NOT NULL
)
SELECT
  *,
  CASE WHEN formation_state = 'formed' THEN json_object(
    'scope_id', scope_id,
    'variant_id', variant_id,
    'gene_id', gene_id,
    'disease_id', disease_id,
    'moi', moi,
    'case_id', case_id,
    'evaluation_mode', evaluation_mode,
    'allow_provisional', allow_provisional,
    'expected_method_codes', expected_method_codes
  ) END AS scope_json
FROM formed
UNION ALL BY NAME
SELECT *, NULL::JSON AS scope_json
FROM failed
