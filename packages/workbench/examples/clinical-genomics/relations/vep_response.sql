SELECT
  r.batch_id,
  'sha256:' || sha256(r.body_text) AS response_digest,
  getvariable('vep_source_id')::VARCHAR AS source_id,
  getvariable('vep_source_version')::VARCHAR AS source_version,
  getvariable('vep_source_uri')::VARCHAR AS source_uri,
  getvariable('vep_observed_at')::VARCHAR AS observed_at,
  json_extract_string(item.value, '$.input') AS input,
  json_extract_string(item.value, '$.id') AS source_record_id,
  json_extract_string(item.value, '$.assembly_name') AS reported_assembly,
  json_extract_string(item.value, '$.seq_region_name') AS reported_chrom,
  try_cast(json_extract(item.value, '$.start') AS BIGINT) AS reported_start,
  try_cast(json_extract(item.value, '$.end') AS BIGINT) AS reported_end,
  json_extract_string(item.value, '$.allele_string') AS reported_allele_string,
  json_extract_string(item.value, '$.most_severe_consequence') AS most_severe_consequence,
  json_extract(item.value, '$.transcript_consequences') AS transcript_consequences,
  coalesce(json_array_length(item.value, '$.transcript_consequences'), 0)::INTEGER AS transcript_count
FROM vep_http_results r
CROSS JOIN json_each(CAST(r.body_text AS JSON)) AS item
WHERE r.status BETWEEN 200 AND 299;
