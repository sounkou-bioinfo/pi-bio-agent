-- Gene-disease-MOI assertions are shared knowledge, not case facts. Admission
-- is explicit: a retrieved or model-proposed assertion cannot form a scope until
-- the host records it as accepted with complete source identity.
SELECT
  try_cast(observation.key AS BIGINT) AS observation_ordinal,
  json_extract_string(observation.value, '$.item_id') AS item_id,
  json_extract_string(observation.value, '$.gene_id') AS gene_id,
  json_extract_string(observation.value, '$.disease_id') AS disease_id,
  upper(json_extract_string(observation.value, '$.moi')) AS moi,
  coalesce(json_extract_string(observation.value, '$.admission_state'), 'proposed') AS admission_state,
  json_extract_string(observation.value, '$.source_id') AS source_id,
  json_extract_string(observation.value, '$.source_version') AS source_version,
  json_extract_string(observation.value, '$.source_uri') AS source_uri,
  json_extract_string(observation.value, '$.source_digest') AS source_digest,
  json_extract_string(observation.value, '$.observed_at') AS observed_at,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(observation.value) field
    WHERE field.key NOT IN (
      'item_id', 'gene_id', 'disease_id', 'moi', 'admission_state',
      'source_id', 'source_version', 'source_uri', 'source_digest', 'observed_at'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(observation.value, '$.item_id')
      AND json_type(observation.value, '$.item_id') NOT IN ('VARCHAR', 'NULL') THEN 'item_id' END,
    CASE WHEN json_exists(observation.value, '$.gene_id')
      AND json_type(observation.value, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
    CASE WHEN json_exists(observation.value, '$.disease_id')
      AND json_type(observation.value, '$.disease_id') NOT IN ('VARCHAR', 'NULL') THEN 'disease_id' END,
    CASE WHEN json_exists(observation.value, '$.moi')
      AND json_type(observation.value, '$.moi') NOT IN ('VARCHAR', 'NULL') THEN 'moi' END,
    CASE WHEN json_exists(observation.value, '$.admission_state')
      AND json_type(observation.value, '$.admission_state') NOT IN ('VARCHAR', 'NULL') THEN 'admission_state' END,
    CASE WHEN json_exists(observation.value, '$.source_id')
      AND json_type(observation.value, '$.source_id') NOT IN ('VARCHAR', 'NULL') THEN 'source_id' END,
    CASE WHEN json_exists(observation.value, '$.source_version')
      AND json_type(observation.value, '$.source_version') NOT IN ('VARCHAR', 'NULL') THEN 'source_version' END,
    CASE WHEN json_exists(observation.value, '$.source_uri')
      AND json_type(observation.value, '$.source_uri') NOT IN ('VARCHAR', 'NULL') THEN 'source_uri' END,
    CASE WHEN json_exists(observation.value, '$.source_digest')
      AND json_type(observation.value, '$.source_digest') NOT IN ('VARCHAR', 'NULL') THEN 'source_digest' END,
    CASE WHEN json_exists(observation.value, '$.observed_at')
      AND json_type(observation.value, '$.observed_at') NOT IN ('VARCHAR', 'NULL') THEN 'observed_at' END
  ], field -> field IS NOT NULL) AS invalid_type_fields
FROM json_each(CAST(getvariable('svcv4_disease_model_observations_json') AS JSON)) observation
