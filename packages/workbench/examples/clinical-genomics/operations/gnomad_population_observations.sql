-- Normalize selected gnomAD frequency strata into the provider-neutral POP_FRQ
-- envelope. Rows remain proposed until a host admits them. Provider filters,
-- GraphQL errors, missing strata, and response identity drift remain explicit.
WITH query_id_counts AS (
  SELECT query_id, count(*)::INTEGER AS query_id_count
  FROM registered_gnomad_population_queries
  WHERE query_id IS NOT NULL
  GROUP BY query_id
), response_joined AS (
  SELECT
    query.*,
    coalesce(query_id_counts.query_id_count, 0) AS query_id_count,
    response.status,
    response.response_digest,
    response.source_id,
    response.source_version,
    response.source_uri,
    response.observed_at,
    response.response_json,
    response.variant_json,
    response.errors_json,
    CASE query.sequencing_type
      WHEN 'exome' THEN json_extract(response.variant_json, '$.exome')
      WHEN 'genome' THEN json_extract(response.variant_json, '$.genome')
      WHEN 'joint' THEN json_extract(response.variant_json, '$.joint')
    END AS frequency_container
  FROM registered_gnomad_population_queries query
  LEFT JOIN query_id_counts USING (query_id)
  LEFT JOIN gnomad_response response USING (batch_id)
), selected_frequency AS (
  SELECT
    joined.*,
    CASE
      WHEN joined.population = 'global' THEN joined.frequency_container
      ELSE (
        SELECT population.value
        FROM json_each(json_extract(joined.frequency_container, '$.populations')) population
        WHERE json_extract_string(population.value, '$.id') = joined.population
        LIMIT 1
      )
    END AS frequency_record,
    coalesce(try_cast(json_extract(joined.frequency_container, '$.filters') AS VARCHAR[]), []::VARCHAR[])
      AS provider_filters,
    coalesce((
      SELECT bool_or(lower(json_extract_string(error.value, '$.message')) LIKE '%variant not found%')
      FROM json_each(joined.errors_json) error
    ), false) AS provider_variant_not_found,
    coalesce(json_array_length(joined.errors_json), 0)::INTEGER AS provider_error_count
  FROM response_joined joined
), audited AS (
  SELECT
    selected.*,
    try_cast(json_extract(selected.frequency_record, '$.ac') AS BIGINT) AS source_ac,
    try_cast(json_extract(selected.frequency_record, '$.an') AS BIGINT) AS source_an,
    json_extract_string(selected.variant_json, '$.variant_id') AS response_variant_id,
    json_extract_string(selected.variant_json, '$.reference_genome') AS response_assembly,
    replace(json_extract_string(selected.variant_json, '$.chrom'), 'chr', '') AS response_chrom,
    try_cast(json_extract(selected.variant_json, '$.pos') AS BIGINT) AS response_pos,
    json_extract_string(selected.variant_json, '$.ref') AS response_ref,
    json_extract_string(selected.variant_json, '$.alt') AS response_alt,
    CASE
      WHEN coalesce(selected.query_id, '') = '' THEN 'invalid_query:missing_query_id'
      WHEN selected.query_id_count > 1 THEN 'invalid_query:duplicate_query_id'
      WHEN len(selected.unknown_fields) > 0 THEN 'invalid_query:unknown_fields'
      WHEN len(selected.invalid_type_fields) > 0 THEN 'invalid_query:field_types'
      WHEN coalesce(selected.scope_id, '') = '' OR coalesce(selected.variant_id, '') = ''
        OR coalesce(selected.disease_id, '') = '' OR coalesce(selected.moi, '') = ''
        THEN 'invalid_query:incomplete_scope_identity'
      WHEN selected.assembly <> 'GRCh38' OR coalesce(selected.chrom, '') = ''
        OR selected.pos IS NULL OR selected.pos <= 0 OR coalesce(selected.ref, '') = '' OR coalesce(selected.alt, '') = ''
        THEN 'invalid_query:allele_identity'
      WHEN selected.source_variant_id IS DISTINCT FROM
        selected.chrom || '-' || selected.pos::VARCHAR || '-' || selected.ref || '-' || selected.alt
        THEN 'invalid_query:source_variant_identity'
      WHEN selected.dataset_id NOT IN ('gnomad_r4', 'gnomad_r4_non_ukb') THEN 'invalid_query:dataset'
      WHEN selected.sequencing_type NOT IN ('exome', 'genome', 'joint') THEN 'invalid_query:sequencing_type'
      WHEN coalesce(selected.population, '') = '' THEN 'invalid_query:population'
    END AS query_contract_error
  FROM selected_frequency selected
), classified AS (
  SELECT
    audited.*,
    audited.variant_json IS NOT NULL AND (
      audited.response_variant_id IS DISTINCT FROM audited.source_variant_id
      OR audited.response_assembly IS DISTINCT FROM audited.assembly
      OR audited.response_chrom IS DISTINCT FROM audited.chrom
      OR audited.response_pos IS DISTINCT FROM audited.pos
      OR audited.response_ref IS DISTINCT FROM audited.ref
      OR audited.response_alt IS DISTINCT FROM audited.alt
    ) AS response_identity_mismatch,
    list_filter([
      audited.query_contract_error,
      CASE WHEN audited.status IS NULL THEN 'http_response_missing' END,
      CASE WHEN audited.response_json IS NULL THEN 'response_not_json' END,
      CASE WHEN audited.provider_variant_not_found THEN 'variant_not_found' END,
      CASE WHEN audited.provider_error_count > 0 AND NOT audited.provider_variant_not_found
        THEN 'provider_graphql_error' END,
      CASE WHEN audited.variant_json IS NOT NULL AND audited.frequency_container IS NULL
        THEN 'sequencing_type_missing' END,
      CASE WHEN audited.frequency_container IS NOT NULL AND audited.frequency_record IS NULL
        THEN 'population_stratum_missing' END,
      CASE WHEN audited.frequency_record IS NOT NULL
        AND (audited.source_ac IS NULL OR audited.source_an IS NULL
          OR audited.source_ac < 0 OR audited.source_an <= 0 OR audited.source_ac > audited.source_an)
        THEN 'invalid_provider_counts' END,
      CASE WHEN audited.variant_json IS NOT NULL AND (
        audited.response_variant_id IS DISTINCT FROM audited.source_variant_id
        OR audited.response_assembly IS DISTINCT FROM audited.assembly
        OR audited.response_chrom IS DISTINCT FROM audited.chrom
        OR audited.response_pos IS DISTINCT FROM audited.pos
        OR audited.response_ref IS DISTINCT FROM audited.ref
        OR audited.response_alt IS DISTINCT FROM audited.alt
      ) THEN 'response_identity_mismatch' END
    ], error -> error IS NOT NULL) AS source_error_codes
  FROM audited
)
SELECT
  'population:sha256:' || sha256(concat_ws('|', coalesce(response_digest, ''), coalesce(query_id, ''))) AS item_id,
  scope_id,
  variant_id,
  gene_id,
  disease_id,
  moi,
  NULL::VARCHAR AS case_id,
  CASE
    WHEN provider_variant_not_found AND query_contract_error IS NULL THEN 'not_observed'
    WHEN len(source_error_codes) = 0 AND source_ac > 0 THEN 'measured'
    WHEN len(source_error_codes) = 0 AND source_ac = 0 THEN 'counted_zero'
    ELSE 'unknown'
  END AS frequency_state,
  CASE
    WHEN query_contract_error IS NOT NULL OR status IS NULL OR response_json IS NULL
      OR (provider_error_count > 0 AND NOT provider_variant_not_found) OR response_identity_mismatch
      THEN 'failed'
    ELSE 'completed'
  END AS query_state,
  CASE WHEN frequency_record IS NOT NULL AND source_an > 0 AND NOT response_identity_mismatch
    THEN 'adequate' ELSE 'unknown' END AS coverage_state,
  CASE
    WHEN frequency_record IS NULL THEN 'unknown'
    WHEN len(provider_filters) = 0 THEN 'passed'
    ELSE 'failed'
  END AS source_filter_state,
  provider_filters AS source_filters,
  'proposed' AS admission_state,
  CASE
    WHEN provider_variant_not_found THEN NULL::DOUBLE
    WHEN source_an > 0 THEN source_ac::DOUBLE / source_an::DOUBLE
  END AS allele_frequency,
  CASE WHEN provider_variant_not_found THEN NULL::BIGINT ELSE source_ac END AS allele_count,
  CASE WHEN provider_variant_not_found THEN NULL::BIGINT ELSE source_an END AS allele_number,
  NULL::BIGINT AS callable_allele_number,
  NULL::BIGINT AS cohort_sample_count,
  CASE WHEN frequency_record IS NOT NULL THEN 'variant_record_post_qc_alleles' END AS denominator_semantics,
  CASE WHEN frequency_record IS NOT NULL THEN 'gnomad_v4_adjusted_variant_record_an' END AS denominator_method,
  CASE WHEN frequency_record IS NOT NULL THEN 'point_estimate' END AS frequency_measure,
  dataset_id || '/' || sequencing_type || '/' || population AS population,
  query_id AS source_query_id,
  dataset_id || ':' || source_variant_id || ':' || sequencing_type || ':' || population AS source_record_id,
  source_error_codes,
  source_id,
  source_version,
  source_uri,
  response_digest AS source_digest,
  observed_at
FROM classified
ORDER BY query_ordinal
