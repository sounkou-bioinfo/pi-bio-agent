SELECT
  json_extract_string(value, '$.case_id') AS case_id,
  json_extract_string(value, '$.gene_id') AS gene_id,
  json_extract_string(value, '$.gene') AS gene,
  from_json(json_extract(value, '$.disease_ids'), '["VARCHAR"]') AS disease_ids,
  try_cast(json_extract(value, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank,
  json_extract_string(value, '$.assembly') AS assembly,
  json_extract_string(value, '$.search_status') AS search_status,
  json_extract_string(value, '$.search_scope') AS search_scope,
  try_cast(json_extract(value, '$.searched_variant_count') AS INTEGER) AS searched_variant_count
FROM json_each(CAST(getvariable('candidate_variant_search_json') AS JSON))
WHERE json_extract_string(value, '$.record_kind') = 'coverage'
  AND json_extract_string(value, '$.case_id') = getvariable('case_id')
