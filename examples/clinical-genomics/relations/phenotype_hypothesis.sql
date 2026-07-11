SELECT
  getvariable('case_id')::VARCHAR AS case_id,
  json_extract_string(value, '$.gene_id') AS gene_id,
  json_extract_string(value, '$.gene') AS gene,
  json_extract_string(value, '$.disease_id') AS disease_id,
  json_extract_string(value, '$.disease_label') AS disease_label,
  try_cast(json_extract(value, '$.matched_observed_terms') AS INTEGER) AS matched_observed_terms,
  try_cast(json_extract(value, '$.exact_observed_terms') AS INTEGER) AS exact_observed_terms,
  try_cast(json_extract(value, '$.phenotype_specificity_score') AS DOUBLE) AS phenotype_specificity_score,
  try_cast(json_extract(value, '$.supporting_phenotype_annotations') AS INTEGER) AS supporting_phenotype_annotations,
  try_cast(json_extract(value, '$.phenotype_match_kinds') AS VARCHAR[]) AS phenotype_match_kinds,
  try_cast(json_extract(value, '$.phenotype_sources') AS VARCHAR[]) AS phenotype_sources,
  try_cast(json_extract(value, '$.has_causal_assertion') AS INTEGER) AS has_causal_assertion,
  try_cast(json_extract(value, '$.gene_disease_assertions') AS INTEGER) AS gene_disease_assertions,
  try_cast(json_extract(value, '$.gene_disease_predicates') AS VARCHAR[]) AS gene_disease_predicates,
  try_cast(json_extract(value, '$.gene_disease_sources') AS VARCHAR[]) AS gene_disease_sources,
  try_cast(json_extract(value, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank
FROM json_each(CAST(getvariable('phenotype_hypotheses_json') AS JSON))
WHERE json_extract_string(value, '$.gene') IS NOT NULL
  AND json_extract_string(value, '$.disease_id') IS NOT NULL
