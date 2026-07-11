SELECT
  r.batch_id,
  json_extract_string(item.value, '$.input') AS input,
  json_extract_string(item.value, '$.most_severe_consequence') AS most_severe_consequence,
  json_extract(item.value, '$.transcript_consequences') AS transcript_consequences,
  json_extract(item.value, '$.colocated_variants') AS colocated_variants
FROM vep_http_results r
CROSS JOIN json_each(CAST(r.body_text AS JSON)) AS item
WHERE r.status BETWEEN 200 AND 299;
