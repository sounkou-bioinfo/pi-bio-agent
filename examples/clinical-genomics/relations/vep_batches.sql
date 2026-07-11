WITH selected AS (
  SELECT
    row_number() OVER (ORDER BY json_extract_string(value, '$.variant_key')) - 1 AS ordinal,
    replace(json_extract_string(value, '$.chrom'), 'chr', '') AS chrom,
    json_extract_string(value, '$.pos') AS pos,
    json_extract_string(value, '$.ref') AS ref,
    json_extract_string(value, '$.alt') AS alt
  FROM json_each(CAST(getvariable('selected_variants_json') AS JSON))
), batched AS (
  SELECT
    (ordinal // 200)::BIGINT AS batch_id,
    chrom || ' ' || pos || ' . ' || ref || ' ' || alt || ' . . .' AS variant
  FROM selected
)
SELECT
  batch_id,
  json_object('variants', json_group_array(variant))::VARCHAR AS body
FROM batched
GROUP BY batch_id
ORDER BY batch_id;
