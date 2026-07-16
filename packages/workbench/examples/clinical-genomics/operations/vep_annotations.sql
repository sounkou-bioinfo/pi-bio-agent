-- VEP is a transcript-consequence provider here. Colocated population values
-- and ClinVar labels have different authorities and release semantics, so this
-- operation does not launder them into annotation evidence.
WITH selected AS (
  SELECT
    json_extract_string(value, '$.case_id') AS case_id,
    json_extract_string(value, '$.variant_id') AS variant_id,
    json_extract_string(value, '$.variant_key') AS variant_key,
    json_extract_string(value, '$.assembly') AS assembly,
    replace(json_extract_string(value, '$.chrom'), 'chr', '') AS chrom,
    try_cast(json_extract(value, '$.pos') AS BIGINT) AS pos,
    json_extract_string(value, '$.ref') AS ref,
    json_extract_string(value, '$.alt') AS alt
  FROM json_each(CAST(getvariable('selected_variants_json') AS JSON))
), responses AS (
  SELECT
    v.*,
    replace(split_part(v.input, ' ', 1), 'chr', '') || '-' || split_part(v.input, ' ', 2)
      || '-' || split_part(v.input, ' ', 4) || '-' || split_part(v.input, ' ', 5) AS source_variant_key,
    replace(split_part(v.input, ' ', 1), 'chr', '') AS source_input_chrom,
    try_cast(split_part(v.input, ' ', 2) AS BIGINT) AS source_input_pos,
    split_part(v.input, ' ', 4) AS source_input_ref,
    split_part(v.input, ' ', 5) AS source_input_alt
  FROM vep_response v
  WHERE v.input IS NOT NULL
), coverage AS (
  SELECT
    'coverage' AS record_kind,
    CASE WHEN r.input IS NULL THEN 'response_missing' ELSE 'completed' END AS annotation_state,
    'annotation:sha256:' || sha256(concat_ws('|', coalesce(r.response_digest, ''), s.variant_key, 'coverage')) AS item_id,
    s.case_id,
    s.variant_id,
    s.variant_key,
    s.assembly,
    s.chrom,
    s.pos,
    s.ref,
    s.alt,
    r.source_variant_key,
    r.reported_assembly,
    r.reported_chrom,
    r.reported_start,
    r.reported_end,
    r.reported_allele_string,
    r.input,
    r.source_record_id,
    r.transcript_count,
    NULL::VARCHAR AS gene_id,
    NULL::VARCHAR AS gene,
    NULL::VARCHAR AS transcript_id,
    NULL::VARCHAR AS transcript_biotype,
    NULL::BOOLEAN AS is_canonical,
    NULL::VARCHAR AS mane_select,
    NULL::VARCHAR[] AS consequence_terms,
    r.most_severe_consequence,
    NULL::VARCHAR AS impact,
    NULL::VARCHAR AS hgvsc,
    NULL::VARCHAR AS hgvsp,
    coalesce(r.source_id, getvariable('vep_source_id')::VARCHAR) AS source_id,
    coalesce(r.source_version, getvariable('vep_source_version')::VARCHAR) AS source_version,
    coalesce(r.source_uri, getvariable('vep_source_uri')::VARCHAR) AS source_uri,
    r.response_digest AS source_digest,
    coalesce(r.observed_at, getvariable('vep_observed_at')::VARCHAR) AS observed_at,
    'accepted' AS admission_state
  FROM selected s
  LEFT JOIN responses r ON r.source_variant_key = s.variant_key
), transcript_rows AS (
  SELECT
    'transcript_consequence' AS record_kind,
    'observed' AS annotation_state,
    'annotation:sha256:' || sha256(concat_ws('|', r.response_digest, s.variant_key,
      coalesce(json_extract_string(tc.value, '$.transcript_id'), ''),
      coalesce(json_extract_string(tc.value, '$.gene_id'), ''),
      coalesce(json_extract_string(tc.value, '$.impact'), ''),
      coalesce(CAST(json_extract(tc.value, '$.consequence_terms') AS VARCHAR), ''))) AS item_id,
    s.case_id,
    s.variant_id,
    s.variant_key,
    s.assembly,
    s.chrom,
    s.pos,
    s.ref,
    s.alt,
    r.source_variant_key,
    r.reported_assembly,
    r.reported_chrom,
    r.reported_start,
    r.reported_end,
    r.reported_allele_string,
    r.input,
    r.source_record_id,
    r.transcript_count,
    json_extract_string(tc.value, '$.gene_id') AS gene_id,
    json_extract_string(tc.value, '$.gene_symbol') AS gene,
    json_extract_string(tc.value, '$.transcript_id') AS transcript_id,
    json_extract_string(tc.value, '$.biotype') AS transcript_biotype,
    coalesce(try_cast(json_extract(tc.value, '$.canonical') AS BOOLEAN), false) AS is_canonical,
    json_extract_string(tc.value, '$.mane_select') AS mane_select,
    try_cast(json_extract(tc.value, '$.consequence_terms') AS VARCHAR[]) AS consequence_terms,
    r.most_severe_consequence,
    json_extract_string(tc.value, '$.impact') AS impact,
    json_extract_string(tc.value, '$.hgvsc') AS hgvsc,
    json_extract_string(tc.value, '$.hgvsp') AS hgvsp,
    r.source_id,
    r.source_version,
    r.source_uri,
    r.response_digest AS source_digest,
    r.observed_at,
    'accepted' AS admission_state
  FROM responses r
  JOIN selected s ON s.variant_key = r.source_variant_key
  CROSS JOIN json_each(r.transcript_consequences) AS tc
), orphan_responses AS (
  -- A provider response that does not match a submitted allele remains visible
  -- as an invalid record instead of disappearing in an inner join.
  SELECT
    'orphan_response' AS record_kind,
    'unregistered_response' AS annotation_state,
    'annotation:sha256:' || sha256(concat_ws('|', r.response_digest, r.source_variant_key, 'orphan')) AS item_id,
    NULL::VARCHAR AS case_id,
    NULL::VARCHAR AS variant_id,
    r.source_variant_key AS variant_key,
    r.reported_assembly AS assembly,
    r.source_input_chrom AS chrom,
    r.source_input_pos AS pos,
    r.source_input_ref AS ref,
    r.source_input_alt AS alt,
    r.source_variant_key,
    r.reported_assembly,
    r.reported_chrom,
    r.reported_start,
    r.reported_end,
    r.reported_allele_string,
    r.input,
    r.source_record_id,
    r.transcript_count,
    NULL::VARCHAR AS gene_id,
    NULL::VARCHAR AS gene,
    NULL::VARCHAR AS transcript_id,
    NULL::VARCHAR AS transcript_biotype,
    NULL::BOOLEAN AS is_canonical,
    NULL::VARCHAR AS mane_select,
    NULL::VARCHAR[] AS consequence_terms,
    r.most_severe_consequence,
    NULL::VARCHAR AS impact,
    NULL::VARCHAR AS hgvsc,
    NULL::VARCHAR AS hgvsp,
    r.source_id,
    r.source_version,
    r.source_uri,
    r.response_digest AS source_digest,
    r.observed_at,
    'rejected' AS admission_state
  FROM responses r
  LEFT JOIN selected s ON s.variant_key = r.source_variant_key
  WHERE s.variant_key IS NULL
)
SELECT * FROM coverage
UNION ALL BY NAME
SELECT * FROM transcript_rows
UNION ALL BY NAME
SELECT * FROM orphan_responses
ORDER BY variant_key, record_kind, gene, transcript_id;
