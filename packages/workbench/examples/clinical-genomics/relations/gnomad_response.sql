-- Preserve the exact response digest and GraphQL error envelope. A 2xx HTTP
-- status means transport completed, not that the requested variant exists.
SELECT
  result.batch_id,
  result.status,
  'sha256:' || sha256(result.body_text) AS response_digest,
  getvariable('gnomad_source_id')::VARCHAR AS source_id,
  getvariable('gnomad_source_version')::VARCHAR AS source_version,
  getvariable('gnomad_source_uri')::VARCHAR AS source_uri,
  getvariable('gnomad_observed_at')::VARCHAR AS observed_at,
  try_cast(result.body_text AS JSON) AS response_json,
  CASE
    WHEN json_type(try_cast(result.body_text AS JSON), '$.data.variant') IN ('OBJECT', 'ARRAY')
      THEN json_extract(try_cast(result.body_text AS JSON), '$.data.variant')
    ELSE NULL::JSON
  END AS variant_json,
  json_extract(try_cast(result.body_text AS JSON), '$.errors') AS errors_json
FROM gnomad_http_results result
