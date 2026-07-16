-- Downstream policy sees only source-pinned transcript observations admitted by
-- the provider-neutral audit. Population frequency and clinical assertions are
-- separate evidence relations and remain explicit nulls here.
SELECT
  json_extract_string(value, '$.variant_key') AS variant_key,
  json_extract_string(value, '$.input') AS input,
  json_extract_string(value, '$.gene_id') AS gene_id,
  json_extract_string(value, '$.gene') AS gene,
  json_extract_string(value, '$.transcript_id') AS transcript_id,
  try_cast(json_extract(value, '$.consequence_terms') AS VARCHAR[]) AS consequence_terms,
  json_extract_string(value, '$.impact') AS impact,
  coalesce(
    json_extract_string(value, '$.consequence_terms[0]'),
    json_extract_string(value, '$.most_severe_consequence')
  ) AS consequence,
  NULL::DOUBLE AS allele_frequency,
  NULL::VARCHAR AS clinical_significance,
  json_extract_string(value, '$.most_severe_consequence') AS most_severe_consequence,
  json_extract_string(value, '$.source_id') AS annotation_source,
  json_extract_string(value, '$.source_version') AS annotation_source_version,
  json_extract_string(value, '$.source_digest') AS annotation_source_digest,
  json_extract_string(value, '$.observed_at') AS annotation_observed_at
FROM json_each(CAST(getvariable('variant_annotation_audit_json') AS JSON))
WHERE coalesce(try_cast(json_extract(value, '$.evidence_eligible') AS BOOLEAN), false)
  AND json_extract_string(value, '$.audit_status') = 'complete'
  AND json_extract_string(value, '$.record_kind') = 'transcript_consequence'
