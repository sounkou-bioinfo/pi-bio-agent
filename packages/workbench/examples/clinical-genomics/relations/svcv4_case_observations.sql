-- A clinical observation is an envelope around the upstream SVCv4 Case
-- payload. The envelope binds that payload to one workbench scope, durable
-- source identity, admission state, and a pseudonymous case id. Raw narrative
-- and family assets remain outside this bounded method-input relation.
SELECT
  try_cast(observation.key AS BIGINT) AS observation_ordinal,
  json_extract_string(observation.value, '$.item_id') AS item_id,
  json_extract_string(observation.value, '$.scope_id') AS scope_id,
  json_extract_string(observation.value, '$.case_id') AS case_id,
  upper(json_extract_string(observation.value, '$.workflow')) AS workflow,
  coalesce(json_extract_string(observation.value, '$.admission_state'), 'proposed') AS admission_state,
  json_extract(observation.value, '$.case') AS case_json,
  CASE
    WHEN NOT json_exists(observation.value, '$.case') THEN 'missing'
    WHEN json_type(observation.value, '$.case') = 'NULL' THEN 'null'
    ELSE lower(json_type(observation.value, '$.case'))
  END AS case_field_state,
  json_extract_string(observation.value, '$.source_id') AS source_id,
  json_extract_string(observation.value, '$.source_version') AS source_version,
  json_extract_string(observation.value, '$.source_uri') AS source_uri,
  json_extract_string(observation.value, '$.source_digest') AS source_digest,
  json_extract_string(observation.value, '$.observed_at') AS observed_at
FROM json_each(CAST(getvariable('svcv4_case_observations_json') AS JSON)) observation
