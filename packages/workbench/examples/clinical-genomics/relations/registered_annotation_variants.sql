-- Register the exact allele identities submitted for annotation. This is a
-- bounded orchestration relation, not a second variant store. Unknown fields
-- and permissive JSON coercions remain visible for the audit operation.
WITH raw_variants AS (
  SELECT
    try_cast(entry.key AS BIGINT) AS registration_ordinal,
    entry.value AS variant_json
  FROM json_each(CAST(getvariable('registered_annotation_variants_json') AS JSON)) entry
)
SELECT
  registration_ordinal,
  json_extract_string(variant_json, '$.case_id') AS case_id,
  json_extract_string(variant_json, '$.variant_id') AS variant_id,
  json_extract_string(variant_json, '$.variant_key') AS variant_key,
  json_extract_string(variant_json, '$.assembly') AS assembly,
  regexp_replace(json_extract_string(variant_json, '$.chrom'), '^chr', '', 'i') AS chrom,
  try_cast(json_extract(variant_json, '$.pos') AS BIGINT) AS pos,
  json_extract_string(variant_json, '$.ref') AS ref,
  json_extract_string(variant_json, '$.alt') AS alt,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(variant_json) field
    WHERE field.key NOT IN (
      'case_id', 'variant_id', 'variant_key', 'assembly', 'chrom', 'pos', 'ref', 'alt'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(variant_json, '$.case_id')
      AND json_type(variant_json, '$.case_id') <> 'VARCHAR' THEN 'case_id' END,
    CASE WHEN json_exists(variant_json, '$.variant_id')
      AND json_type(variant_json, '$.variant_id') NOT IN ('VARCHAR', 'NULL') THEN 'variant_id' END,
    CASE WHEN json_exists(variant_json, '$.variant_key')
      AND json_type(variant_json, '$.variant_key') <> 'VARCHAR' THEN 'variant_key' END,
    CASE WHEN json_exists(variant_json, '$.assembly')
      AND json_type(variant_json, '$.assembly') <> 'VARCHAR' THEN 'assembly' END,
    CASE WHEN json_exists(variant_json, '$.chrom')
      AND json_type(variant_json, '$.chrom') <> 'VARCHAR' THEN 'chrom' END,
    CASE WHEN json_exists(variant_json, '$.pos')
      AND json_type(variant_json, '$.pos') NOT IN ('BIGINT', 'UBIGINT') THEN 'pos' END,
    CASE WHEN json_exists(variant_json, '$.ref')
      AND json_type(variant_json, '$.ref') <> 'VARCHAR' THEN 'ref' END,
    CASE WHEN json_exists(variant_json, '$.alt')
      AND json_type(variant_json, '$.alt') <> 'VARCHAR' THEN 'alt' END
  ], field -> field IS NOT NULL) AS invalid_type_fields
FROM raw_variants
