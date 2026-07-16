-- Provider responses are normalized before policy sees them. Frequency state,
-- field presence, query completion, coverage, and admission remain separate:
-- an omitted value, JSON null, numeric zero, and a completed no-hit query do not
-- mean the same thing and must never be collapsed with coalesce(..., 0).
--
-- Source AC/AN belong to an emitted variant-frequency record. A completed
-- no-hit has no such record, so it carries explicit null AC/AN and a separate
-- locus-specific callable denominator. The latter is where assay, ploidy,
-- coverage, QC, and bioinformatics limitations must already have been applied.
SELECT
  try_cast(observation.key AS BIGINT) AS observation_ordinal,
  json_extract_string(observation.value, '$.item_id') AS item_id,
  json_extract_string(observation.value, '$.scope_id') AS scope_id,
  json_extract_string(observation.value, '$.variant_id') AS variant_id,
  json_extract_string(observation.value, '$.gene_id') AS gene_id,
  json_extract_string(observation.value, '$.disease_id') AS disease_id,
  upper(json_extract_string(observation.value, '$.moi')) AS moi,
  json_extract_string(observation.value, '$.case_id') AS case_id,
  coalesce(json_extract_string(observation.value, '$.frequency_state'), 'not_captured') AS frequency_state,
  coalesce(json_extract_string(observation.value, '$.query_state'), 'not_queried') AS query_state,
  coalesce(json_extract_string(observation.value, '$.coverage_state'), 'unknown') AS coverage_state,
  coalesce(json_extract_string(observation.value, '$.source_filter_state'), 'unknown') AS source_filter_state,
  coalesce(try_cast(json_extract(observation.value, '$.source_filters') AS VARCHAR[]), []::VARCHAR[]) AS source_filters,
  coalesce(json_extract_string(observation.value, '$.admission_state'), 'proposed') AS admission_state,
  CASE
    WHEN NOT json_exists(observation.value, '$.allele_frequency') THEN 'missing'
    WHEN json_type(observation.value, '$.allele_frequency') = 'NULL' THEN 'null'
    ELSE 'value'
  END AS allele_frequency_field_state,
  try_cast(json_extract(observation.value, '$.allele_frequency') AS DOUBLE) AS allele_frequency,
  CASE
    WHEN NOT json_exists(observation.value, '$.allele_count') THEN 'missing'
    WHEN json_type(observation.value, '$.allele_count') = 'NULL' THEN 'null'
    ELSE 'value'
  END AS allele_count_field_state,
  try_cast(json_extract(observation.value, '$.allele_count') AS BIGINT) AS allele_count,
  CASE
    WHEN NOT json_exists(observation.value, '$.allele_number') THEN 'missing'
    WHEN json_type(observation.value, '$.allele_number') = 'NULL' THEN 'null'
    ELSE 'value'
  END AS allele_number_field_state,
  try_cast(json_extract(observation.value, '$.allele_number') AS BIGINT) AS allele_number,
  CASE
    WHEN NOT json_exists(observation.value, '$.callable_allele_number') THEN 'missing'
    WHEN json_type(observation.value, '$.callable_allele_number') = 'NULL' THEN 'null'
    ELSE 'value'
  END AS callable_allele_number_field_state,
  try_cast(json_extract(observation.value, '$.callable_allele_number') AS BIGINT) AS callable_allele_number,
  try_cast(json_extract(observation.value, '$.cohort_sample_count') AS BIGINT) AS cohort_sample_count,
  json_extract_string(observation.value, '$.denominator_semantics') AS denominator_semantics,
  json_extract_string(observation.value, '$.denominator_method') AS denominator_method,
  json_extract_string(observation.value, '$.frequency_measure') AS frequency_measure,
  json_extract_string(observation.value, '$.population') AS population,
  json_extract_string(observation.value, '$.source_query_id') AS source_query_id,
  json_extract_string(observation.value, '$.source_record_id') AS source_record_id,
  coalesce(try_cast(json_extract(observation.value, '$.source_error_codes') AS VARCHAR[]), []::VARCHAR[])
    AS source_error_codes,
  json_extract_string(observation.value, '$.source_id') AS source_id,
  json_extract_string(observation.value, '$.source_version') AS source_version,
  json_extract_string(observation.value, '$.source_uri') AS source_uri,
  json_extract_string(observation.value, '$.source_digest') AS source_digest,
  json_extract_string(observation.value, '$.observed_at') AS observed_at,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(observation.value) field
    WHERE field.key NOT IN (
      'item_id', 'scope_id', 'variant_id', 'gene_id', 'disease_id', 'moi', 'case_id',
      'frequency_state', 'query_state', 'coverage_state', 'source_filter_state',
      'source_filters', 'admission_state',
      'allele_frequency', 'allele_count', 'allele_number', 'callable_allele_number',
      'cohort_sample_count', 'denominator_semantics', 'denominator_method',
      'frequency_measure', 'population', 'source_query_id', 'source_record_id',
      'source_error_codes',
      'source_id', 'source_version', 'source_uri', 'source_digest', 'observed_at',
      'inheritance', 'de_novo'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(observation.value, '$.item_id')
      AND json_type(observation.value, '$.item_id') <> 'VARCHAR' THEN 'item_id' END,
    CASE WHEN json_exists(observation.value, '$.scope_id')
      AND json_type(observation.value, '$.scope_id') <> 'VARCHAR' THEN 'scope_id' END,
    CASE WHEN json_exists(observation.value, '$.variant_id')
      AND json_type(observation.value, '$.variant_id') <> 'VARCHAR' THEN 'variant_id' END,
    CASE WHEN json_exists(observation.value, '$.gene_id')
      AND json_type(observation.value, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
    CASE WHEN json_exists(observation.value, '$.disease_id')
      AND json_type(observation.value, '$.disease_id') <> 'VARCHAR' THEN 'disease_id' END,
    CASE WHEN json_exists(observation.value, '$.moi')
      AND json_type(observation.value, '$.moi') <> 'VARCHAR' THEN 'moi' END,
    CASE WHEN json_exists(observation.value, '$.case_id')
      AND json_type(observation.value, '$.case_id') NOT IN ('VARCHAR', 'NULL') THEN 'case_id' END,
    CASE WHEN json_exists(observation.value, '$.frequency_state')
      AND json_type(observation.value, '$.frequency_state') <> 'VARCHAR' THEN 'frequency_state' END,
    CASE WHEN json_exists(observation.value, '$.query_state')
      AND json_type(observation.value, '$.query_state') <> 'VARCHAR' THEN 'query_state' END,
    CASE WHEN json_exists(observation.value, '$.coverage_state')
      AND json_type(observation.value, '$.coverage_state') <> 'VARCHAR' THEN 'coverage_state' END,
    CASE WHEN json_exists(observation.value, '$.source_filter_state')
      AND json_type(observation.value, '$.source_filter_state') <> 'VARCHAR' THEN 'source_filter_state' END,
    CASE WHEN json_exists(observation.value, '$.source_filters') AND (
      json_type(observation.value, '$.source_filters') <> 'ARRAY'
      OR coalesce((
        SELECT count(*)
        FROM json_each(json_extract(observation.value, '$.source_filters')) source_filter
        WHERE json_type(source_filter.value) <> 'VARCHAR'
      ), 0) > 0
    ) THEN 'source_filters' END,
    CASE WHEN json_exists(observation.value, '$.admission_state')
      AND json_type(observation.value, '$.admission_state') <> 'VARCHAR' THEN 'admission_state' END,
    CASE WHEN json_exists(observation.value, '$.allele_frequency')
      AND json_type(observation.value, '$.allele_frequency') NOT IN ('BIGINT', 'UBIGINT', 'DOUBLE', 'NULL')
      THEN 'allele_frequency' END,
    CASE WHEN json_exists(observation.value, '$.allele_count')
      AND json_type(observation.value, '$.allele_count') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'allele_count' END,
    CASE WHEN json_exists(observation.value, '$.allele_number')
      AND json_type(observation.value, '$.allele_number') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'allele_number' END,
    CASE WHEN json_exists(observation.value, '$.callable_allele_number')
      AND json_type(observation.value, '$.callable_allele_number') NOT IN ('BIGINT', 'UBIGINT', 'NULL')
      THEN 'callable_allele_number' END,
    CASE WHEN json_exists(observation.value, '$.cohort_sample_count')
      AND json_type(observation.value, '$.cohort_sample_count') NOT IN ('BIGINT', 'UBIGINT', 'NULL')
      THEN 'cohort_sample_count' END,
    CASE WHEN json_exists(observation.value, '$.population')
      AND json_type(observation.value, '$.population') <> 'VARCHAR' THEN 'population' END,
    CASE WHEN json_exists(observation.value, '$.source_query_id')
      AND json_type(observation.value, '$.source_query_id') NOT IN ('VARCHAR', 'NULL') THEN 'source_query_id' END,
    CASE WHEN json_exists(observation.value, '$.source_record_id')
      AND json_type(observation.value, '$.source_record_id') NOT IN ('VARCHAR', 'NULL') THEN 'source_record_id' END,
    CASE WHEN json_exists(observation.value, '$.source_error_codes') AND (
      json_type(observation.value, '$.source_error_codes') <> 'ARRAY'
      OR coalesce((
        SELECT count(*)
        FROM json_each(json_extract(observation.value, '$.source_error_codes')) source_error
        WHERE json_type(source_error.value) <> 'VARCHAR'
      ), 0) > 0
    ) THEN 'source_error_codes' END,
    CASE WHEN json_exists(observation.value, '$.source_id')
      AND json_type(observation.value, '$.source_id') <> 'VARCHAR' THEN 'source_id' END,
    CASE WHEN json_exists(observation.value, '$.source_version')
      AND json_type(observation.value, '$.source_version') <> 'VARCHAR' THEN 'source_version' END,
    CASE WHEN json_exists(observation.value, '$.source_uri')
      AND json_type(observation.value, '$.source_uri') <> 'VARCHAR' THEN 'source_uri' END,
    CASE WHEN json_exists(observation.value, '$.source_digest')
      AND json_type(observation.value, '$.source_digest') <> 'VARCHAR' THEN 'source_digest' END,
    CASE WHEN json_exists(observation.value, '$.observed_at')
      AND json_type(observation.value, '$.observed_at') <> 'VARCHAR' THEN 'observed_at' END
  ], field -> field IS NOT NULL) AS invalid_type_fields,
  -- De novo/inheritance evidence belongs to CLN_DNV and related case methods.
  -- Detect it here so it cannot be smuggled in as a population-frequency state.
  (json_exists(observation.value, '$.inheritance') OR json_exists(observation.value, '$.de_novo')) AS has_case_inheritance
FROM json_each(CAST(getvariable('svcv4_population_observations_json') AS JSON)) observation
