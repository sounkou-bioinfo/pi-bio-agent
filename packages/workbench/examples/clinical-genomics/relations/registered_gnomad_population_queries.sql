-- One row requests one source stratum for one exact SVCv4 scope. HTTP batches
-- are deduplicated by dataset and variant, while sequencing-type and population
-- selection remains explicit in the registered query contract.
WITH raw_queries AS (
  SELECT
    try_cast(query.key AS BIGINT) AS query_ordinal,
    query.value AS query_json
  FROM json_each(CAST(getvariable('gnomad_population_queries_json') AS JSON)) query
), normalized AS (
  SELECT
    query_ordinal,
    query_json,
    json_extract_string(query_json, '$.source_variant_id') AS source_variant_id,
    json_extract_string(query_json, '$.dataset_id') AS dataset_id
  FROM raw_queries
)
SELECT
  query_ordinal,
  dense_rank() OVER (ORDER BY dataset_id, source_variant_id) - 1 AS batch_id,
  json_extract_string(query_json, '$.query_id') AS query_id,
  json_extract_string(query_json, '$.scope_id') AS scope_id,
  json_extract_string(query_json, '$.variant_id') AS variant_id,
  json_extract_string(query_json, '$.gene_id') AS gene_id,
  json_extract_string(query_json, '$.disease_id') AS disease_id,
  upper(json_extract_string(query_json, '$.moi')) AS moi,
  json_extract_string(query_json, '$.assembly') AS assembly,
  replace(json_extract_string(query_json, '$.chrom'), 'chr', '') AS chrom,
  try_cast(json_extract(query_json, '$.pos') AS BIGINT) AS pos,
  json_extract_string(query_json, '$.ref') AS ref,
  json_extract_string(query_json, '$.alt') AS alt,
  source_variant_id,
  dataset_id,
  lower(json_extract_string(query_json, '$.sequencing_type')) AS sequencing_type,
  json_extract_string(query_json, '$.population') AS population,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(query_json) field
    WHERE field.key NOT IN (
      'query_id', 'scope_id', 'variant_id', 'gene_id', 'disease_id', 'moi',
      'assembly', 'chrom', 'pos', 'ref', 'alt', 'source_variant_id',
      'dataset_id', 'sequencing_type', 'population'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(query_json, '$.query_id')
      AND json_type(query_json, '$.query_id') <> 'VARCHAR' THEN 'query_id' END,
    CASE WHEN json_exists(query_json, '$.scope_id')
      AND json_type(query_json, '$.scope_id') <> 'VARCHAR' THEN 'scope_id' END,
    CASE WHEN json_exists(query_json, '$.variant_id')
      AND json_type(query_json, '$.variant_id') <> 'VARCHAR' THEN 'variant_id' END,
    CASE WHEN json_exists(query_json, '$.gene_id')
      AND json_type(query_json, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
    CASE WHEN json_exists(query_json, '$.disease_id')
      AND json_type(query_json, '$.disease_id') <> 'VARCHAR' THEN 'disease_id' END,
    CASE WHEN json_exists(query_json, '$.moi')
      AND json_type(query_json, '$.moi') <> 'VARCHAR' THEN 'moi' END,
    CASE WHEN json_exists(query_json, '$.assembly')
      AND json_type(query_json, '$.assembly') <> 'VARCHAR' THEN 'assembly' END,
    CASE WHEN json_exists(query_json, '$.chrom')
      AND json_type(query_json, '$.chrom') <> 'VARCHAR' THEN 'chrom' END,
    CASE WHEN json_exists(query_json, '$.pos')
      AND json_type(query_json, '$.pos') NOT IN ('BIGINT', 'UBIGINT') THEN 'pos' END,
    CASE WHEN json_exists(query_json, '$.ref')
      AND json_type(query_json, '$.ref') <> 'VARCHAR' THEN 'ref' END,
    CASE WHEN json_exists(query_json, '$.alt')
      AND json_type(query_json, '$.alt') <> 'VARCHAR' THEN 'alt' END,
    CASE WHEN json_exists(query_json, '$.source_variant_id')
      AND json_type(query_json, '$.source_variant_id') <> 'VARCHAR' THEN 'source_variant_id' END,
    CASE WHEN json_exists(query_json, '$.dataset_id')
      AND json_type(query_json, '$.dataset_id') <> 'VARCHAR' THEN 'dataset_id' END,
    CASE WHEN json_exists(query_json, '$.sequencing_type')
      AND json_type(query_json, '$.sequencing_type') <> 'VARCHAR' THEN 'sequencing_type' END,
    CASE WHEN json_exists(query_json, '$.population')
      AND json_type(query_json, '$.population') <> 'VARCHAR' THEN 'population' END
  ], field -> field IS NOT NULL) AS invalid_type_fields
FROM normalized
