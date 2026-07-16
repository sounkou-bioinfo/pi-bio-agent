-- Disease maximum credible frequency is scoped method evidence, not a field
-- owned by a population database. Keep the numeric value, derivation identity,
-- source snapshot, and host admission decision separate from AC/AN observations.
-- This relation normalizes shape only; svcv4_pop_frq_lines applies scope and
-- completeness policy without deriving a value from prevalence on its own.
SELECT
  try_cast(observation.key AS BIGINT) AS observation_ordinal,
  json_extract_string(observation.value, '$.item_id') AS item_id,
  json_extract_string(observation.value, '$.scope_id') AS scope_id,
  json_extract_string(observation.value, '$.variant_id') AS variant_id,
  json_extract_string(observation.value, '$.gene_id') AS gene_id,
  json_extract_string(observation.value, '$.disease_id') AS disease_id,
  upper(json_extract_string(observation.value, '$.moi')) AS moi,
  json_extract_string(observation.value, '$.case_id') AS case_id,
  coalesce(json_extract_string(observation.value, '$.admission_state'), 'proposed') AS admission_state,
  json_extract_string(observation.value, '$.frequency_measure') AS frequency_measure,
  CASE
    WHEN NOT json_exists(observation.value, '$.disease_max_credible_frequency') THEN 'missing'
    WHEN json_type(observation.value, '$.disease_max_credible_frequency') = 'NULL' THEN 'null'
    ELSE 'value'
  END AS disease_max_credible_frequency_field_state,
  try_cast(json_extract(observation.value, '$.disease_max_credible_frequency') AS DOUBLE)
    AS disease_max_credible_frequency,
  json_extract_string(observation.value, '$.derivation_method') AS derivation_method,
  json_extract_string(observation.value, '$.derivation_version') AS derivation_version,
  json_extract_string(observation.value, '$.derivation_digest') AS derivation_digest,
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
      'admission_state', 'frequency_measure', 'disease_max_credible_frequency',
      'derivation_method', 'derivation_version', 'derivation_digest',
      'source_id', 'source_version', 'source_uri', 'source_digest', 'observed_at'
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
    CASE WHEN json_exists(observation.value, '$.admission_state')
      AND json_type(observation.value, '$.admission_state') <> 'VARCHAR' THEN 'admission_state' END,
    CASE WHEN json_exists(observation.value, '$.frequency_measure')
      AND json_type(observation.value, '$.frequency_measure') <> 'VARCHAR' THEN 'frequency_measure' END,
    CASE WHEN json_exists(observation.value, '$.disease_max_credible_frequency')
      AND json_type(observation.value, '$.disease_max_credible_frequency') NOT IN ('BIGINT', 'UBIGINT', 'DOUBLE', 'NULL')
      THEN 'disease_max_credible_frequency' END,
    CASE WHEN json_exists(observation.value, '$.derivation_method')
      AND json_type(observation.value, '$.derivation_method') <> 'VARCHAR' THEN 'derivation_method' END,
    CASE WHEN json_exists(observation.value, '$.derivation_version')
      AND json_type(observation.value, '$.derivation_version') <> 'VARCHAR' THEN 'derivation_version' END,
    CASE WHEN json_exists(observation.value, '$.derivation_digest')
      AND json_type(observation.value, '$.derivation_digest') <> 'VARCHAR' THEN 'derivation_digest' END,
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
  ], field -> field IS NOT NULL) AS invalid_type_fields
FROM json_each(CAST(getvariable('svcv4_disease_frequency_observations_json') AS JSON)) observation
