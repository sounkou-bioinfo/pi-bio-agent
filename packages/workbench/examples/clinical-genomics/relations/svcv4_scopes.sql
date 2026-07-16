-- Runtime scopes identify the exact VBC-MDE question. Large evidence stays in
-- DuckDB/CAS; this bounded JSON is only the orchestration contract. Keep input
-- shape errors visible rather than relying on DuckDB's permissive JSON casts.
WITH raw_scopes AS (
  SELECT
    try_cast(scope.key AS BIGINT) AS scope_ordinal,
    scope.value AS scope_json
  FROM json_each(CAST(getvariable('svcv4_scopes_json') AS JSON)) scope
)
SELECT
  scope_ordinal,
  json_extract_string(scope_json, '$.scope_id') AS scope_id,
  json_extract_string(scope_json, '$.variant_id') AS variant_id,
  json_extract_string(scope_json, '$.gene_id') AS gene_id,
  json_extract_string(scope_json, '$.disease_id') AS disease_id,
  upper(json_extract_string(scope_json, '$.moi')) AS moi,
  json_extract_string(scope_json, '$.case_id') AS case_id,
  json_extract_string(scope_json, '$.evaluation_mode') AS evaluation_mode,
  json_extract_string(scope_json, '$.requested_profile_id') AS requested_profile_id,
  json_extract_string(scope_json, '$.requested_profile_version') AS requested_profile_version,
  coalesce(try_cast(json_extract(scope_json, '$.allow_provisional') AS BOOLEAN), false) AS allow_provisional,
  coalesce(try_cast(json_extract(scope_json, '$.expected_method_codes') AS VARCHAR[]), []::VARCHAR[]) AS expected_method_codes,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(scope_json) field
    WHERE field.key NOT IN (
      'scope_id', 'variant_id', 'gene_id', 'disease_id', 'moi', 'case_id',
      'evaluation_mode', 'requested_profile_id', 'requested_profile_version',
      'allow_provisional', 'expected_method_codes'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(scope_json, '$.scope_id')
      AND json_type(scope_json, '$.scope_id') <> 'VARCHAR' THEN 'scope_id' END,
    CASE WHEN json_exists(scope_json, '$.variant_id')
      AND json_type(scope_json, '$.variant_id') <> 'VARCHAR' THEN 'variant_id' END,
    CASE WHEN json_exists(scope_json, '$.gene_id')
      AND json_type(scope_json, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
    CASE WHEN json_exists(scope_json, '$.disease_id')
      AND json_type(scope_json, '$.disease_id') <> 'VARCHAR' THEN 'disease_id' END,
    CASE WHEN json_exists(scope_json, '$.moi')
      AND json_type(scope_json, '$.moi') <> 'VARCHAR' THEN 'moi' END,
    CASE WHEN json_exists(scope_json, '$.case_id')
      AND json_type(scope_json, '$.case_id') NOT IN ('VARCHAR', 'NULL') THEN 'case_id' END,
    CASE WHEN json_exists(scope_json, '$.evaluation_mode')
      AND json_type(scope_json, '$.evaluation_mode') <> 'VARCHAR' THEN 'evaluation_mode' END,
    CASE WHEN json_exists(scope_json, '$.requested_profile_id')
      AND json_type(scope_json, '$.requested_profile_id') NOT IN ('VARCHAR', 'NULL') THEN 'requested_profile_id' END,
    CASE WHEN json_exists(scope_json, '$.requested_profile_version')
      AND json_type(scope_json, '$.requested_profile_version') NOT IN ('VARCHAR', 'NULL') THEN 'requested_profile_version' END,
    CASE WHEN json_exists(scope_json, '$.allow_provisional')
      AND json_type(scope_json, '$.allow_provisional') <> 'BOOLEAN' THEN 'allow_provisional' END,
    CASE WHEN NOT json_exists(scope_json, '$.expected_method_codes')
      OR json_type(scope_json, '$.expected_method_codes') <> 'ARRAY' THEN 'expected_method_codes' END
  ], field -> field IS NOT NULL) AS invalid_type_fields,
  coalesce((
    SELECT count(*)::INTEGER
    FROM json_each(json_extract(scope_json, '$.expected_method_codes')) method
    WHERE json_type(method.value) <> 'VARCHAR'
  ), 0) AS invalid_method_code_type_count
FROM raw_scopes
