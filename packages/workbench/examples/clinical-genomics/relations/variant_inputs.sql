SELECT
  'direct' AS variant_source,
  v.case_id,
  NULL::VARCHAR AS selection_gene_id,
  v.gene,
  NULL::VARCHAR[] AS selection_disease_ids,
  NULL::INTEGER AS hypothesis_rank,
  v.variant_key,
  v.gene AS annotated_gene,
  v.consequence,
  try_cast(v.allele_frequency AS DOUBLE) AS allele_frequency,
  v.clinical_significance,
  v.zygosity,
  v.inheritance
FROM case_variants v
WHERE v.case_id = getvariable('case_id')
UNION ALL
SELECT
  'inverted' AS variant_source,
  json_extract_string(value, '$.case_id') AS case_id,
  json_extract_string(value, '$.gene_id') AS selection_gene_id,
  json_extract_string(value, '$.gene') AS gene,
  from_json(json_extract(value, '$.disease_ids'), '["VARCHAR"]') AS selection_disease_ids,
  try_cast(json_extract(value, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank,
  json_extract_string(value, '$.variant_key') AS variant_key,
  json_extract_string(value, '$.annotated_gene') AS annotated_gene,
  json_extract_string(value, '$.consequence') AS consequence,
  try_cast(json_extract(value, '$.allele_frequency') AS DOUBLE) AS allele_frequency,
  json_extract_string(value, '$.clinical_significance') AS clinical_significance,
  json_extract_string(value, '$.zygosity') AS zygosity,
  json_extract_string(value, '$.inheritance') AS inheritance
FROM json_each(CAST(getvariable('candidate_variant_search_json') AS JSON))
WHERE json_extract_string(value, '$.record_kind') = 'variant'
  AND json_extract_string(value, '$.case_id') = getvariable('case_id')
