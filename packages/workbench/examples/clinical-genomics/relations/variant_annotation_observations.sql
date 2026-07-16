-- Providers enter one common observation contract. Coverage rows prove that a
-- submitted allele received a response even when no transcript consequence was
-- emitted. Transcript rows are evidence candidates only after the separate
-- audit relation admits their identity, source, and response cardinality.
WITH raw_observations AS (
  SELECT
    try_cast(entry.key AS BIGINT) AS observation_ordinal,
    entry.value AS observation_json
  FROM json_each(CAST(getvariable('variant_annotation_observations_json') AS JSON)) entry
)
SELECT
  observation_ordinal,
  json_extract_string(observation_json, '$.record_kind') AS record_kind,
  json_extract_string(observation_json, '$.annotation_state') AS annotation_state,
  json_extract_string(observation_json, '$.item_id') AS item_id,
  json_extract_string(observation_json, '$.case_id') AS case_id,
  json_extract_string(observation_json, '$.variant_id') AS variant_id,
  json_extract_string(observation_json, '$.variant_key') AS variant_key,
  json_extract_string(observation_json, '$.assembly') AS assembly,
  regexp_replace(json_extract_string(observation_json, '$.chrom'), '^chr', '', 'i') AS chrom,
  try_cast(json_extract(observation_json, '$.pos') AS BIGINT) AS pos,
  json_extract_string(observation_json, '$.ref') AS ref,
  json_extract_string(observation_json, '$.alt') AS alt,
  json_extract_string(observation_json, '$.source_variant_key') AS source_variant_key,
  json_extract_string(observation_json, '$.reported_assembly') AS reported_assembly,
  json_extract_string(observation_json, '$.reported_chrom') AS reported_chrom,
  try_cast(json_extract(observation_json, '$.reported_start') AS BIGINT) AS reported_start,
  try_cast(json_extract(observation_json, '$.reported_end') AS BIGINT) AS reported_end,
  json_extract_string(observation_json, '$.reported_allele_string') AS reported_allele_string,
  json_extract_string(observation_json, '$.input') AS input,
  json_extract_string(observation_json, '$.source_record_id') AS source_record_id,
  try_cast(json_extract(observation_json, '$.transcript_count') AS INTEGER) AS transcript_count,
  json_extract_string(observation_json, '$.gene_id') AS gene_id,
  json_extract_string(observation_json, '$.gene') AS gene,
  json_extract_string(observation_json, '$.transcript_id') AS transcript_id,
  json_extract_string(observation_json, '$.transcript_biotype') AS transcript_biotype,
  try_cast(json_extract(observation_json, '$.is_canonical') AS BOOLEAN) AS is_canonical,
  json_extract_string(observation_json, '$.mane_select') AS mane_select,
  try_cast(json_extract(observation_json, '$.consequence_terms') AS VARCHAR[]) AS consequence_terms,
  json_extract_string(observation_json, '$.most_severe_consequence') AS most_severe_consequence,
  json_extract_string(observation_json, '$.impact') AS impact,
  json_extract_string(observation_json, '$.hgvsc') AS hgvsc,
  json_extract_string(observation_json, '$.hgvsp') AS hgvsp,
  json_extract_string(observation_json, '$.source_id') AS source_id,
  json_extract_string(observation_json, '$.source_version') AS source_version,
  json_extract_string(observation_json, '$.source_uri') AS source_uri,
  json_extract_string(observation_json, '$.source_digest') AS source_digest,
  json_extract_string(observation_json, '$.observed_at') AS observed_at,
  json_extract_string(observation_json, '$.admission_state') AS admission_state,
  coalesce((
    SELECT list_sort(list(field.key))
    FROM json_each(observation_json) field
    WHERE field.key NOT IN (
      'record_kind', 'annotation_state', 'item_id', 'case_id', 'variant_id',
      'variant_key', 'assembly', 'chrom', 'pos', 'ref', 'alt',
      'source_variant_key', 'reported_assembly', 'reported_chrom',
      'reported_start', 'reported_end', 'reported_allele_string', 'input',
      'source_record_id', 'transcript_count', 'gene_id', 'gene',
      'transcript_id', 'transcript_biotype', 'is_canonical', 'mane_select',
      'consequence_terms', 'most_severe_consequence', 'impact', 'hgvsc',
      'hgvsp', 'source_id', 'source_version', 'source_uri', 'source_digest',
      'observed_at', 'admission_state'
    )
  ), []::VARCHAR[]) AS unknown_fields,
  list_filter([
    CASE WHEN json_exists(observation_json, '$.record_kind')
      AND json_type(observation_json, '$.record_kind') <> 'VARCHAR' THEN 'record_kind' END,
    CASE WHEN json_exists(observation_json, '$.annotation_state')
      AND json_type(observation_json, '$.annotation_state') <> 'VARCHAR' THEN 'annotation_state' END,
    CASE WHEN json_exists(observation_json, '$.item_id')
      AND json_type(observation_json, '$.item_id') <> 'VARCHAR' THEN 'item_id' END,
    CASE WHEN json_exists(observation_json, '$.case_id')
      AND json_type(observation_json, '$.case_id') NOT IN ('VARCHAR', 'NULL') THEN 'case_id' END,
    CASE WHEN json_exists(observation_json, '$.variant_id')
      AND json_type(observation_json, '$.variant_id') NOT IN ('VARCHAR', 'NULL') THEN 'variant_id' END,
    CASE WHEN json_exists(observation_json, '$.variant_key')
      AND json_type(observation_json, '$.variant_key') <> 'VARCHAR' THEN 'variant_key' END,
    CASE WHEN json_exists(observation_json, '$.assembly')
      AND json_type(observation_json, '$.assembly') NOT IN ('VARCHAR', 'NULL') THEN 'assembly' END,
    CASE WHEN json_exists(observation_json, '$.chrom')
      AND json_type(observation_json, '$.chrom') NOT IN ('VARCHAR', 'NULL') THEN 'chrom' END,
    CASE WHEN json_exists(observation_json, '$.pos')
      AND json_type(observation_json, '$.pos') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'pos' END,
    CASE WHEN json_exists(observation_json, '$.ref')
      AND json_type(observation_json, '$.ref') NOT IN ('VARCHAR', 'NULL') THEN 'ref' END,
    CASE WHEN json_exists(observation_json, '$.alt')
      AND json_type(observation_json, '$.alt') NOT IN ('VARCHAR', 'NULL') THEN 'alt' END,
    CASE WHEN json_exists(observation_json, '$.source_variant_key')
      AND json_type(observation_json, '$.source_variant_key') NOT IN ('VARCHAR', 'NULL') THEN 'source_variant_key' END,
    CASE WHEN json_exists(observation_json, '$.reported_assembly')
      AND json_type(observation_json, '$.reported_assembly') NOT IN ('VARCHAR', 'NULL') THEN 'reported_assembly' END,
    CASE WHEN json_exists(observation_json, '$.reported_chrom')
      AND json_type(observation_json, '$.reported_chrom') NOT IN ('VARCHAR', 'NULL') THEN 'reported_chrom' END,
    CASE WHEN json_exists(observation_json, '$.reported_start')
      AND json_type(observation_json, '$.reported_start') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'reported_start' END,
    CASE WHEN json_exists(observation_json, '$.reported_end')
      AND json_type(observation_json, '$.reported_end') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'reported_end' END,
    CASE WHEN json_exists(observation_json, '$.reported_allele_string')
      AND json_type(observation_json, '$.reported_allele_string') NOT IN ('VARCHAR', 'NULL') THEN 'reported_allele_string' END,
    CASE WHEN json_exists(observation_json, '$.input')
      AND json_type(observation_json, '$.input') NOT IN ('VARCHAR', 'NULL') THEN 'input' END,
    CASE WHEN json_exists(observation_json, '$.source_record_id')
      AND json_type(observation_json, '$.source_record_id') NOT IN ('VARCHAR', 'NULL') THEN 'source_record_id' END,
    CASE WHEN json_exists(observation_json, '$.transcript_count')
      AND json_type(observation_json, '$.transcript_count') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'transcript_count' END,
    CASE WHEN json_exists(observation_json, '$.gene_id')
      AND json_type(observation_json, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
    CASE WHEN json_exists(observation_json, '$.gene')
      AND json_type(observation_json, '$.gene') NOT IN ('VARCHAR', 'NULL') THEN 'gene' END,
    CASE WHEN json_exists(observation_json, '$.transcript_id')
      AND json_type(observation_json, '$.transcript_id') NOT IN ('VARCHAR', 'NULL') THEN 'transcript_id' END,
    CASE WHEN json_exists(observation_json, '$.transcript_biotype')
      AND json_type(observation_json, '$.transcript_biotype') NOT IN ('VARCHAR', 'NULL') THEN 'transcript_biotype' END,
    CASE WHEN json_exists(observation_json, '$.is_canonical')
      AND json_type(observation_json, '$.is_canonical') NOT IN ('BOOLEAN', 'NULL') THEN 'is_canonical' END,
    CASE WHEN json_exists(observation_json, '$.mane_select')
      AND json_type(observation_json, '$.mane_select') NOT IN ('VARCHAR', 'NULL') THEN 'mane_select' END,
    CASE WHEN json_exists(observation_json, '$.consequence_terms')
      AND json_type(observation_json, '$.consequence_terms') NOT IN ('ARRAY', 'NULL') THEN 'consequence_terms' END,
    CASE WHEN json_exists(observation_json, '$.most_severe_consequence')
      AND json_type(observation_json, '$.most_severe_consequence') NOT IN ('VARCHAR', 'NULL') THEN 'most_severe_consequence' END,
    CASE WHEN json_exists(observation_json, '$.impact')
      AND json_type(observation_json, '$.impact') NOT IN ('VARCHAR', 'NULL') THEN 'impact' END,
    CASE WHEN json_exists(observation_json, '$.hgvsc')
      AND json_type(observation_json, '$.hgvsc') NOT IN ('VARCHAR', 'NULL') THEN 'hgvsc' END,
    CASE WHEN json_exists(observation_json, '$.hgvsp')
      AND json_type(observation_json, '$.hgvsp') NOT IN ('VARCHAR', 'NULL') THEN 'hgvsp' END,
    CASE WHEN json_exists(observation_json, '$.source_id')
      AND json_type(observation_json, '$.source_id') NOT IN ('VARCHAR', 'NULL') THEN 'source_id' END,
    CASE WHEN json_exists(observation_json, '$.source_version')
      AND json_type(observation_json, '$.source_version') NOT IN ('VARCHAR', 'NULL') THEN 'source_version' END,
    CASE WHEN json_exists(observation_json, '$.source_uri')
      AND json_type(observation_json, '$.source_uri') NOT IN ('VARCHAR', 'NULL') THEN 'source_uri' END,
    CASE WHEN json_exists(observation_json, '$.source_digest')
      AND json_type(observation_json, '$.source_digest') NOT IN ('VARCHAR', 'NULL') THEN 'source_digest' END,
    CASE WHEN json_exists(observation_json, '$.observed_at')
      AND json_type(observation_json, '$.observed_at') NOT IN ('VARCHAR', 'NULL') THEN 'observed_at' END,
    CASE WHEN json_exists(observation_json, '$.admission_state')
      AND json_type(observation_json, '$.admission_state') NOT IN ('VARCHAR', 'NULL') THEN 'admission_state' END
  ], field -> field IS NOT NULL) AS invalid_type_fields,
  coalesce((
    SELECT count(*)::INTEGER
    FROM json_each(CASE
      WHEN json_type(observation_json, '$.consequence_terms') = 'ARRAY'
        THEN json_extract(observation_json, '$.consequence_terms')
      ELSE '[]'::JSON
    END) term
    WHERE json_type(term.value) <> 'VARCHAR'
  ), 0) AS invalid_consequence_term_type_count
FROM raw_observations
