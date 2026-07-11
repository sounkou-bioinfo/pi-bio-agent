SELECT
  json_extract_string(value, '$.variant_key') AS variant_key,
  json_extract_string(value, '$.input') AS input,
  json_extract_string(value, '$.gene') AS gene,
  json_extract_string(value, '$.impact') AS impact,
  json_extract_string(value, '$.consequence') AS consequence,
  try_cast(json_extract(value, '$.allele_frequency') AS DOUBLE) AS allele_frequency,
  json_extract_string(value, '$.clinical_significance') AS clinical_significance,
  json_extract_string(value, '$.most_severe_consequence') AS most_severe_consequence,
  json_extract_string(value, '$.annotation_source') AS annotation_source
FROM json_each(CAST(getvariable('vep_annotations_json') AS JSON))
WHERE coalesce(json_extract_string(value, '$.variant_key'), '') <> '';
