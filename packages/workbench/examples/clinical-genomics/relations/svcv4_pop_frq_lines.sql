-- POP_FRQ evaluates a scoped disease-frequency ratio. The disease maximum
-- credible frequency is evidence supplied by an approved upstream method; this
-- operation deliberately does not infer it from prevalence or penetrance.
WITH disease_item_counts AS (
  SELECT item_id, count(*)::INTEGER AS item_id_count
  FROM svcv4_disease_frequency_observations
  WHERE item_id IS NOT NULL
  GROUP BY item_id
), disease_joined AS (
  SELECT
    p.scope_id,
    p.variant_id,
    p.gene_id,
    p.disease_id,
    p.moi,
    p.case_id,
    p.evaluation_mode,
    d.observation_ordinal,
    d.item_id,
    d.admission_state,
    d.frequency_measure,
    d.disease_max_credible_frequency_field_state,
    d.disease_max_credible_frequency,
    d.derivation_method,
    d.derivation_version,
    d.derivation_digest,
    d.source_id,
    d.source_version,
    d.source_uri,
    d.source_digest,
    d.observed_at,
    d.unknown_fields,
    d.invalid_type_fields,
    coalesce(dic.item_id_count, 0) AS item_id_count,
    CASE
      WHEN d.observation_ordinal IS NULL THEN 'missing_disease_frequency_evidence'
      WHEN coalesce(d.item_id, '') = '' THEN 'missing_disease_frequency_item_id'
      WHEN coalesce(dic.item_id_count, 0) > 1 THEN 'duplicate_disease_frequency_item_id'
      WHEN len(d.unknown_fields) > 0 THEN 'unknown_disease_frequency_fields'
      WHEN len(d.invalid_type_fields) > 0 THEN 'invalid_disease_frequency_field_types'
      WHEN p.evaluation_mode <> 'case_independent' THEN 'method_requires_case_independent_scope'
      WHEN d.variant_id IS DISTINCT FROM p.variant_id
        OR d.gene_id IS DISTINCT FROM p.gene_id
        OR d.disease_id IS DISTINCT FROM p.disease_id
        OR d.moi IS DISTINCT FROM p.moi THEN 'disease_frequency_scope_identity_mismatch'
      WHEN d.case_id IS NOT NULL THEN 'case_context_on_disease_frequency_evidence'
      WHEN d.admission_state <> 'accepted' THEN 'disease_frequency_evidence_not_admitted'
      WHEN coalesce(d.source_id, '') = '' OR coalesce(d.source_version, '') = ''
        OR coalesce(d.source_uri, '') = '' OR coalesce(d.observed_at, '') = ''
        OR NOT regexp_matches(coalesce(d.source_digest, ''), '^sha256:[0-9a-f]{64}$')
        THEN 'incomplete_disease_frequency_source_identity'
      WHEN try_cast(d.observed_at AS TIMESTAMPTZ) IS NULL THEN 'invalid_disease_frequency_observed_at'
      WHEN d.frequency_measure IS DISTINCT FROM 'maximum_credible_population_allele_frequency'
        THEN 'unsupported_disease_frequency_measure'
      WHEN d.disease_max_credible_frequency_field_state <> 'value'
        OR d.disease_max_credible_frequency IS NULL
        OR d.disease_max_credible_frequency <= 0
        OR d.disease_max_credible_frequency > 1 THEN 'invalid_disease_max_credible_frequency'
      WHEN coalesce(d.derivation_method, '') = '' OR coalesce(d.derivation_version, '') = ''
        OR NOT regexp_matches(coalesce(d.derivation_digest, ''), '^sha256:[0-9a-f]{64}$')
        THEN 'incomplete_disease_frequency_derivation_identity'
    END AS disease_frequency_error
  FROM svcv4_profile_selection p
  LEFT JOIN svcv4_disease_frequency_observations d
    ON d.scope_id = p.scope_id
  LEFT JOIN disease_item_counts dic ON dic.item_id = d.item_id
), disease_summary AS (
  SELECT
    scope_id,
    count(observation_ordinal)::INTEGER AS observation_count,
    count(*) FILTER (WHERE disease_frequency_error IS NULL)::INTEGER AS valid_count,
    count(*) FILTER (
      WHERE disease_frequency_error IS NOT NULL
        AND disease_frequency_error <> 'missing_disease_frequency_evidence'
    )::INTEGER AS blocking_error_count,
    count(*) FILTER (WHERE disease_frequency_error = 'disease_frequency_evidence_not_admitted')::INTEGER
      AS not_admitted_count,
    coalesce(
      list_sort(list_distinct(list(disease_frequency_error) FILTER (
        WHERE disease_frequency_error IS NOT NULL
          AND disease_frequency_error <> 'missing_disease_frequency_evidence'
      ))),
      []::VARCHAR[]
    ) AS disease_frequency_errors
  FROM disease_joined
  GROUP BY scope_id
), selected_disease_frequency AS (
  SELECT * EXCLUDE (disease_frequency_rank)
  FROM (
    SELECT
      *,
      row_number() OVER (PARTITION BY scope_id ORDER BY item_id) AS disease_frequency_rank
    FROM disease_joined
    WHERE disease_frequency_error IS NULL
  )
  WHERE disease_frequency_rank = 1
), population_item_counts AS (
  SELECT item_id, count(*)::INTEGER AS item_id_count
  FROM svcv4_population_observations
  WHERE item_id IS NOT NULL
  GROUP BY item_id
), joined AS (
  SELECT
    p.*,
    o.observation_ordinal,
    o.item_id,
    o.scope_id AS observation_scope_id,
    o.frequency_state,
    o.query_state,
    o.coverage_state,
    o.source_filter_state,
    o.source_filters,
    o.admission_state,
    o.allele_frequency_field_state,
    o.allele_frequency,
    o.allele_count_field_state,
    o.allele_count,
    o.allele_number_field_state,
    o.allele_number,
    o.callable_allele_number_field_state,
    o.callable_allele_number,
    o.cohort_sample_count,
    o.denominator_semantics,
    o.denominator_method,
    o.frequency_measure,
    o.population,
    o.source_query_id,
    o.source_record_id,
    o.source_error_codes,
    o.source_id,
    o.source_version,
    o.source_uri,
    o.source_digest,
    o.observed_at,
    o.unknown_fields,
    o.invalid_type_fields,
    df.item_id AS disease_frequency_item_id,
    df.disease_max_credible_frequency,
    df.derivation_method AS disease_frequency_derivation_method,
    df.derivation_version AS disease_frequency_derivation_version,
    df.derivation_digest AS disease_frequency_derivation_digest,
    df.source_id AS disease_frequency_source_id,
    df.source_version AS disease_frequency_source_version,
    df.source_uri AS disease_frequency_source_uri,
    df.source_digest AS disease_frequency_source_digest,
    df.observed_at AS disease_frequency_observed_at,
    coalesce(pic.item_id_count, 0) AS item_id_count,
    CASE
      WHEN o.observation_ordinal IS NULL THEN 'missing_observation'
      WHEN coalesce(o.item_id, '') = '' THEN 'missing_item_id'
      WHEN coalesce(pic.item_id_count, 0) > 1 THEN 'duplicate_item_id'
      WHEN len(o.unknown_fields) > 0 THEN 'unknown_observation_fields'
      WHEN len(o.invalid_type_fields) > 0 THEN 'invalid_observation_field_types'
      WHEN p.evaluation_mode <> 'case_independent' THEN 'method_requires_case_independent_scope'
      WHEN o.variant_id IS DISTINCT FROM p.variant_id
        OR o.gene_id IS DISTINCT FROM p.gene_id
        OR o.disease_id IS DISTINCT FROM p.disease_id
        OR o.moi IS DISTINCT FROM p.moi THEN 'scope_identity_mismatch'
      WHEN o.admission_state <> 'accepted' THEN 'evidence_not_admitted'
      WHEN coalesce(o.source_id, '') = '' OR coalesce(o.source_version, '') = ''
        OR coalesce(o.source_uri, '') = '' OR coalesce(o.observed_at, '') = ''
        OR NOT regexp_matches(coalesce(o.source_digest, ''), '^sha256:[0-9a-f]{64}$')
        THEN 'incomplete_source_identity'
      WHEN try_cast(o.observed_at AS TIMESTAMPTZ) IS NULL THEN 'invalid_observed_at'
      WHEN o.has_case_inheritance THEN 'case_inheritance_on_population_observation'
      WHEN o.case_id IS NOT NULL THEN 'case_context_on_population_observation'
      WHEN o.frequency_state NOT IN ('measured', 'counted_zero', 'not_observed', 'unknown', 'not_captured', 'not_applicable')
        THEN 'invalid_frequency_state'
      WHEN o.frequency_state = 'not_applicable' THEN 'not_applicable'
      WHEN o.frequency_state = 'not_captured' THEN 'frequency_not_captured'
      WHEN o.frequency_state = 'unknown' THEN 'frequency_unknown'
      WHEN o.query_state = 'not_queried' THEN 'frequency_not_queried'
      WHEN o.query_state = 'failed' THEN 'frequency_query_failed'
      WHEN o.query_state <> 'completed' THEN 'invalid_query_state'
      WHEN o.coverage_state <> 'adequate' THEN 'population_coverage_not_adequate'
      WHEN o.source_filter_state NOT IN ('passed', 'failed', 'unknown') THEN 'invalid_population_source_filter_state'
      WHEN o.source_filter_state = 'passed' AND len(o.source_filters) > 0 THEN 'population_source_filter_state_mismatch'
      WHEN o.source_filter_state <> 'passed' THEN 'population_source_not_filter_passed'
      -- A positive measured frequency may be supplied directly. Zero is not
      -- accepted in this state because it carries no denominator semantics.
      WHEN o.frequency_state = 'measured' AND o.allele_frequency_field_state <> 'value'
        THEN 'measured_frequency_missing'
      WHEN o.frequency_state = 'measured' AND o.frequency_measure IS DISTINCT FROM 'point_estimate'
        THEN 'unsupported_frequency_measure'
      WHEN o.frequency_state = 'measured' AND (o.allele_frequency IS NULL OR o.allele_frequency <= 0 OR o.allele_frequency > 1)
        THEN 'invalid_measured_allele_frequency'
      WHEN o.frequency_state = 'measured' AND ((o.allele_count IS NULL) <> (o.allele_number IS NULL))
        THEN 'incomplete_allele_counts'
      WHEN o.frequency_state = 'measured' AND o.allele_count IS NOT NULL
        AND (o.allele_count <= 0 OR o.allele_number <= 0 OR o.allele_count > o.allele_number)
        THEN 'invalid_allele_counts'
      WHEN o.frequency_state = 'measured' AND o.allele_count IS NOT NULL
        AND abs(o.allele_frequency - (o.allele_count::DOUBLE / o.allele_number::DOUBLE)) > 1e-9
        THEN 'frequency_count_mismatch'
      -- A counted-zero row is an actual source frequency record: its observed
      -- sample frequency is zero and its source AC/AN are both explicit. That
      -- point estimate does not assert that the population frequency is zero.
      WHEN o.frequency_state = 'counted_zero' AND o.allele_frequency_field_state <> 'value'
        THEN 'counted_zero_frequency_missing'
      WHEN o.frequency_state = 'counted_zero' AND o.allele_frequency IS DISTINCT FROM 0::DOUBLE
        THEN 'counted_zero_frequency_not_zero'
      WHEN o.frequency_state = 'counted_zero'
        AND (o.allele_count_field_state <> 'value' OR o.allele_number_field_state <> 'value'
          OR o.allele_count IS DISTINCT FROM 0::BIGINT OR o.allele_number IS NULL OR o.allele_number <= 0)
        THEN 'invalid_counted_zero_denominator'
      WHEN o.frequency_state = 'counted_zero'
        AND o.denominator_semantics IS DISTINCT FROM 'variant_record_post_qc_alleles'
        THEN 'unsupported_counted_zero_denominator_semantics'
      WHEN o.frequency_state = 'counted_zero' AND coalesce(o.denominator_method, '') = ''
        THEN 'counted_zero_denominator_method_missing'
      -- A no-hit query has no variant-frequency record. AF, AC, and source AN
      -- therefore remain explicit JSON null. A separate locus-level callable
      -- denominator supports a finite-panel bound without fabricating a row.
      WHEN o.frequency_state = 'not_observed' AND o.allele_frequency_field_state <> 'null'
        THEN 'not_observed_frequency_must_be_null'
      WHEN o.frequency_state = 'not_observed'
        AND (o.allele_count_field_state <> 'null' OR o.allele_number_field_state <> 'null')
        THEN 'not_observed_variant_counts_must_be_null'
      WHEN o.frequency_state = 'not_observed'
        AND (o.callable_allele_number_field_state <> 'value'
          OR o.callable_allele_number IS NULL OR o.callable_allele_number <= 0)
        THEN 'invalid_not_observed_callable_denominator'
      WHEN o.frequency_state = 'not_observed'
        AND o.denominator_semantics IS DISTINCT FROM 'locus_post_qc_callable_alleles'
        THEN 'unsupported_not_observed_denominator_semantics'
      WHEN o.frequency_state = 'not_observed' AND coalesce(o.denominator_method, '') = ''
        THEN 'not_observed_denominator_method_missing'
      WHEN o.frequency_state IN ('counted_zero', 'not_observed')
        AND o.cohort_sample_count IS NOT NULL AND o.cohort_sample_count <= 0
        THEN 'invalid_cohort_sample_count'
      WHEN o.frequency_state IN ('counted_zero', 'not_observed') AND coalesce(o.population, '') = ''
        THEN 'missing_population_stratum'
    END AS observation_error,
    CASE
      WHEN o.frequency_state = 'measured' AND o.allele_frequency > 0 AND df.disease_max_credible_frequency > 0
        THEN o.allele_frequency / df.disease_max_credible_frequency
    END AS frequency_ratio
  FROM svcv4_profile_selection p
  LEFT JOIN svcv4_population_observations o
    ON o.scope_id = p.scope_id
  LEFT JOIN population_item_counts pic ON pic.item_id = o.item_id
  LEFT JOIN selected_disease_frequency df ON df.scope_id = p.scope_id
), observation_summary AS (
  SELECT
    scope_id,
    count(observation_ordinal)::INTEGER AS observation_count,
    count(*) FILTER (WHERE observation_error IS NULL)::INTEGER AS valid_count,
    count(*) FILTER (WHERE observation_error IS NULL AND frequency_state = 'measured')::INTEGER AS measured_count,
    count(*) FILTER (WHERE observation_error IS NULL AND frequency_state = 'counted_zero')::INTEGER AS counted_zero_count,
    count(*) FILTER (WHERE observation_error IS NULL AND frequency_state = 'not_observed')::INTEGER AS not_observed_count,
    count(*) FILTER (
      WHERE observation_error IS NOT NULL
        AND observation_error NOT IN ('missing_observation', 'not_applicable')
    )::INTEGER AS blocking_error_count,
    count(*) FILTER (WHERE observation_error = 'not_applicable')::INTEGER AS not_applicable_count,
    count(*) FILTER (WHERE observation_error = 'evidence_not_admitted')::INTEGER AS not_admitted_count,
    count(*) FILTER (WHERE observation_error = 'frequency_unknown')::INTEGER AS unknown_count,
    count(*) FILTER (WHERE observation_error = 'frequency_not_captured')::INTEGER AS not_captured_count,
    count(*) FILTER (WHERE observation_error = 'frequency_not_queried')::INTEGER AS not_queried_count,
    count(*) FILTER (WHERE observation_error = 'case_inheritance_on_population_observation')::INTEGER AS case_inheritance_count,
    count(*) FILTER (WHERE observation_error = 'case_context_on_population_observation')::INTEGER AS case_context_count,
    coalesce(
      list_sort(list_distinct(list(observation_error) FILTER (
        WHERE observation_error IS NOT NULL AND observation_error <> 'missing_observation'
      ))),
      []::VARCHAR[]
    ) AS observation_errors
  FROM joined
  GROUP BY scope_id
), ranked_valid AS (
  -- SVCv4 uses the strongest population-frequency contradiction. Select the
  -- greatest admitted ratio, with stable source/item ordering only for ties.
  SELECT
    *,
    row_number() OVER (
      PARTITION BY scope_id
      ORDER BY frequency_ratio DESC, source_id, source_version, item_id
    ) AS observation_rank
  FROM joined
  WHERE observation_error IS NULL AND frequency_state = 'measured'
), selected_observation AS (
  SELECT *
  FROM ranked_valid
  WHERE observation_rank = 1
), population_bound_policy AS (
  -- This policy is application-owned and provisional, not asserted to be text
  -- from the unfinished SVCv4 Standard. It makes the estimator, confidence, and
  -- denominator semantics reviewable data.
  SELECT
    profile_id::VARCHAR AS profile_id,
    profile_version::VARCHAR AS profile_version,
    method_code::VARCHAR AS method_code,
    frequency_state::VARCHAR AS frequency_state,
    bound_method::VARCHAR AS bound_method,
    try_cast(confidence_level AS DOUBLE) AS confidence_level,
    denominator_semantics::VARCHAR AS denominator_semantics,
    zero_score_rule_id::VARCHAR AS zero_score_rule_id,
    policy_status::VARCHAR AS policy_status,
    source_id::VARCHAR AS source_id
  FROM svcv4_population_bound_policy
  WHERE policy_status = 'provisional'
), zero_or_absence_bounds AS (
  SELECT
    j.*,
    bp.bound_method AS applied_bound_method,
    bp.confidence_level AS applied_confidence_level,
    bp.zero_score_rule_id,
    bp.source_id AS bound_policy_source_id,
    CASE j.frequency_state
      WHEN 'counted_zero' THEN j.allele_number
      WHEN 'not_observed' THEN j.callable_allele_number
    END AS bound_allele_number,
    CASE
      -- Conditional on AN independent, searchable alleles, the one-sided exact
      -- zero-event binomial upper bound solves (1-p)^AN = 1-confidence. The
      -- denominator is source AN for a counted-zero record and independently
      -- derived locus-callable AN for a completed no-hit. Nominal cohort size is
      -- never substituted for either denominator.
      WHEN bp.bound_method = 'zero_count_binomial_one_sided_exact'
        AND bp.confidence_level > 0 AND bp.confidence_level < 1
        AND CASE j.frequency_state
          WHEN 'counted_zero' THEN j.allele_number
          WHEN 'not_observed' THEN j.callable_allele_number
        END > 0
        THEN 1 - pow(
          1 - bp.confidence_level,
          1::DOUBLE / CASE j.frequency_state
            WHEN 'counted_zero' THEN j.allele_number::DOUBLE
            WHEN 'not_observed' THEN j.callable_allele_number::DOUBLE
          END
        )
    END AS derived_upper_frequency_bound
  FROM joined j
  LEFT JOIN population_bound_policy bp
    ON bp.profile_id = j.profile_id
   AND bp.profile_version = j.profile_version
   AND bp.method_code = 'POP_FRQ'
   AND bp.frequency_state = j.frequency_state
   AND bp.denominator_semantics = j.denominator_semantics
  WHERE j.observation_error IS NULL AND j.frequency_state IN ('counted_zero', 'not_observed')
), bounded_zero_or_absence AS (
  SELECT
    b.*,
    b.derived_upper_frequency_bound / b.disease_max_credible_frequency AS upper_frequency_ratio,
    t.upper_bound::DOUBLE AS zero_score_upper_ratio,
    try_cast(t.upper_inclusive AS BOOLEAN) AS zero_score_upper_inclusive,
    CASE
      WHEN b.applied_bound_method IS NULL THEN 'bound_policy_not_configured'
      WHEN b.derived_upper_frequency_bound IS NULL THEN 'bound_not_computable'
      WHEN t.rule_id IS NULL THEN 'zero_score_rule_not_configured'
      WHEN CASE WHEN try_cast(t.upper_inclusive AS BOOLEAN)
        THEN b.derived_upper_frequency_bound / b.disease_max_credible_frequency <= try_cast(t.upper_bound AS DOUBLE)
        ELSE b.derived_upper_frequency_bound / b.disease_max_credible_frequency < try_cast(t.upper_bound AS DOUBLE)
      END THEN 'bound_within_zero_score_interval'
      ELSE 'bound_crosses_scoring_threshold'
    END AS bound_decision
  FROM zero_or_absence_bounds b
  LEFT JOIN svcv4_numeric_thresholds t
    ON t.profile_id = b.profile_id
   AND t.profile_version = b.profile_version
   AND t.method_code = 'POP_FRQ'
   AND t.measurement = 'frequency_ratio_to_disease_max'
   AND t.rule_id = b.zero_score_rule_id
), ranked_zero_or_absence AS (
  -- Select the largest upper ratio. If that conservative bound remains inside
  -- the zero-point interval, every smaller admitted bound does too.
  SELECT
    *,
    row_number() OVER (
      PARTITION BY scope_id
      ORDER BY upper_frequency_ratio DESC NULLS FIRST,
        CASE frequency_state WHEN 'counted_zero' THEN 0 ELSE 1 END,
        source_id, source_version, item_id
    ) AS bound_rank,
    list_sort(list(item_id) OVER (PARTITION BY scope_id)) AS bounded_item_ids
  FROM bounded_zero_or_absence
), selected_zero_or_absence_bound AS (
  SELECT *
  FROM ranked_zero_or_absence
  WHERE bound_rank = 1
), threshold_matches AS (
  -- Threshold bins are configuration rows. Inclusive/exclusive endpoints are
  -- data, which keeps boundary review out of application code.
  SELECT
    o.scope_id,
    try_cast(t.score AS DOUBLE) AS threshold_score,
    t.rule_id::VARCHAR AS rule_id,
    t.source_id::VARCHAR AS rule_source_id,
    row_number() OVER (PARTITION BY o.scope_id ORDER BY try_cast(t.priority AS INTEGER), t.rule_id) AS threshold_rank
  FROM selected_observation o
  JOIN svcv4_numeric_thresholds t
    ON t.profile_id = o.profile_id
   AND t.profile_version = o.profile_version
   AND t.method_code = 'POP_FRQ'
   AND t.measurement = 'frequency_ratio_to_disease_max'
   AND (
     nullif(t.lower_bound::VARCHAR, '') IS NULL
     OR CASE WHEN try_cast(t.lower_inclusive AS BOOLEAN)
       THEN o.frequency_ratio >= try_cast(t.lower_bound AS DOUBLE)
       ELSE o.frequency_ratio > try_cast(t.lower_bound AS DOUBLE)
     END
   )
   AND (
     nullif(t.upper_bound::VARCHAR, '') IS NULL
     OR CASE WHEN try_cast(t.upper_inclusive AS BOOLEAN)
       THEN o.frequency_ratio <= try_cast(t.upper_bound AS DOUBLE)
       ELSE o.frequency_ratio < try_cast(t.upper_bound AS DOUBLE)
     END
   )
), selected_threshold AS (
  SELECT *
  FROM threshold_matches
  WHERE threshold_rank = 1
), policy AS (
  SELECT *
  FROM svcv4_evaluator_policy
  WHERE method_code = 'POP_FRQ' AND policy_status = 'active'
)
SELECT
  -- Emit one method-result line for every requested scope, including explicit
  -- not_applicable and not_evaluated states. Downstream aggregation never has to
  -- infer what a missing row meant.
  p.scope_id || ':POP_FRQ' AS line_id,
  p.scope_id,
  p.variant_id,
  p.gene_id,
  p.disease_id,
  p.moi,
  p.case_id,
  p.profile_id,
  p.profile_version,
  p.profile_status,
  'POP_FRQ' AS method_code,
  CASE
    WHEN p.selection_status <> 'selected' THEN 'not_evaluated'
    WHEN pol.evaluator_id IS NULL THEN 'not_evaluated'
    WHEN s.observation_count = 0 THEN 'not_evaluated'
    WHEN s.valid_count = 0 AND s.not_applicable_count = s.observation_count THEN 'not_applicable'
    WHEN ds.observation_count = 0 OR ds.blocking_error_count > 0 OR ds.valid_count <> 1 THEN 'not_evaluated'
    WHEN s.blocking_error_count > 0 OR s.valid_count = 0 THEN 'not_evaluated'
    WHEN s.measured_count = 0 AND (s.counted_zero_count + s.not_observed_count) > 0
      AND zb.bound_decision = 'bound_within_zero_score_interval' THEN 'no_evidence'
    WHEN s.measured_count = 0 AND (s.counted_zero_count + s.not_observed_count) > 0 THEN 'not_evaluated'
    WHEN t.rule_id IS NULL THEN 'not_evaluated'
    ELSE 'scored'
  END AS evaluation_state,
  CASE
    WHEN p.selection_status = 'selected' AND pol.evaluator_id IS NOT NULL
      AND ds.valid_count = 1 AND s.valid_count > 0 AND t.rule_id IS NOT NULL
      THEN t.threshold_score
  END AS score,
  CASE
    WHEN p.selection_status <> 'selected' THEN p.selection_status
    WHEN pol.evaluator_id IS NULL THEN 'evaluator_policy_missing'
    WHEN s.observation_count = 0 THEN 'population_observation_missing'
    WHEN s.valid_count = 0 AND s.not_applicable_count = s.observation_count THEN 'method_not_applicable'
    WHEN ds.observation_count = 0 THEN 'disease_frequency_evidence_missing'
    WHEN ds.valid_count > 1 THEN 'disease_frequency_evidence_ambiguous'
    WHEN ds.not_admitted_count > 0 THEN 'disease_frequency_evidence_not_admitted'
    WHEN ds.blocking_error_count > 0 OR ds.valid_count <> 1 THEN 'invalid_disease_frequency_evidence'
    WHEN s.not_admitted_count > 0 THEN 'population_evidence_not_admitted'
    WHEN s.not_queried_count > 0 THEN 'population_frequency_not_queried'
    WHEN s.not_captured_count > 0 THEN 'population_frequency_not_captured'
    WHEN s.unknown_count > 0 THEN 'population_frequency_unknown'
    WHEN s.case_inheritance_count > 0 THEN 'case_inheritance_on_population_observation'
    WHEN s.case_context_count > 0 THEN 'case_context_on_population_observation'
    WHEN s.blocking_error_count > 0 OR s.valid_count = 0 THEN 'invalid_population_observation'
    WHEN s.measured_count = 0 AND (s.counted_zero_count + s.not_observed_count) > 0
      AND zb.bound_decision = 'bound_within_zero_score_interval' THEN 'population_upper_bound_within_zero_score_interval'
    WHEN s.measured_count = 0 AND (s.counted_zero_count + s.not_observed_count) > 0
      THEN coalesce(zb.bound_decision, 'population_bound_not_evaluated')
    WHEN t.rule_id IS NULL THEN 'frequency_threshold_not_configured'
    ELSE t.rule_id
  END AS reason_code,
  coalesce(o.frequency_ratio, zb.upper_frequency_ratio) AS measurement_value,
  CASE WHEN o.item_id IS NOT NULL
    THEN 'frequency_ratio_to_disease_max'
    ELSE 'upper_frequency_ratio_to_disease_max'
  END AS measurement,
  coalesce(o.frequency_state, zb.frequency_state) AS measurement_state,
  coalesce(o.allele_count, zb.allele_count) AS allele_count,
  coalesce(o.allele_number, zb.allele_number) AS source_allele_number,
  zb.callable_allele_number,
  zb.bound_allele_number,
  coalesce(o.cohort_sample_count, zb.cohort_sample_count) AS cohort_sample_count,
  coalesce(o.denominator_semantics, zb.denominator_semantics) AS denominator_semantics,
  coalesce(o.denominator_method, zb.denominator_method) AS denominator_method,
  coalesce(o.population, zb.population) AS population,
  coalesce(o.source_filter_state, zb.source_filter_state) AS source_filter_state,
  coalesce(o.source_filters, zb.source_filters, []::VARCHAR[]) AS source_filters,
  coalesce(o.source_query_id, zb.source_query_id) AS source_query_id,
  coalesce(o.source_record_id, zb.source_record_id) AS source_record_id,
  coalesce(o.source_error_codes, zb.source_error_codes, []::VARCHAR[]) AS source_error_codes,
  zb.derived_upper_frequency_bound,
  zb.applied_bound_method,
  zb.applied_confidence_level,
  zb.bound_policy_source_id,
  zb.bound_decision,
  coalesce(s.observation_errors, []::VARCHAR[]) AS observation_errors,
  coalesce(ds.disease_frequency_errors, []::VARCHAR[]) AS disease_frequency_errors,
  CASE
    WHEN o.item_id IS NOT NULL THEN list_sort([o.item_id, df.item_id])
    WHEN zb.item_id IS NOT NULL THEN list_sort(list_append(zb.bounded_item_ids, df.item_id))
    ELSE []::VARCHAR[]
  END AS evidence_item_ids,
  coalesce(o.source_id, zb.source_id) AS source_id,
  coalesce(o.source_version, zb.source_version) AS source_version,
  coalesce(o.source_uri, zb.source_uri) AS source_uri,
  coalesce(o.source_digest, zb.source_digest) AS source_digest,
  coalesce(o.observed_at, zb.observed_at) AS observed_at,
  df.item_id AS disease_frequency_item_id,
  df.disease_max_credible_frequency,
  df.derivation_method AS disease_frequency_derivation_method,
  df.derivation_version AS disease_frequency_derivation_version,
  df.derivation_digest AS disease_frequency_derivation_digest,
  df.source_id AS disease_frequency_source_id,
  df.source_version AS disease_frequency_source_version,
  df.source_uri AS disease_frequency_source_uri,
  df.source_digest AS disease_frequency_source_digest,
  df.observed_at AS disease_frequency_observed_at,
  t.rule_source_id,
  pol.evaluator_id::VARCHAR AS evaluator_id,
  pol.evaluator_version::VARCHAR AS evaluator_version,
  pol.method_definition_digest::VARCHAR AS method_definition_digest,
  NULL::VARCHAR AS branch_group,
  NULL::VARCHAR AS branch_id
FROM svcv4_profile_selection p
LEFT JOIN disease_summary ds USING (scope_id)
LEFT JOIN selected_disease_frequency df USING (scope_id)
LEFT JOIN observation_summary s USING (scope_id)
LEFT JOIN selected_observation o USING (scope_id)
LEFT JOIN selected_zero_or_absence_bound zb USING (scope_id)
LEFT JOIN selected_threshold t USING (scope_id)
LEFT JOIN policy pol
  ON pol.profile_id = p.profile_id
 AND pol.profile_version = p.profile_version
ORDER BY p.scope_id
