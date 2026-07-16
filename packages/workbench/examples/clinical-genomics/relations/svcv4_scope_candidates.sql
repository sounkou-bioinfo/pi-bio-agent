-- Candidate rows come from one checkpointed indexed-search run. Preserve the
-- run and result identities on every row so scope formation can be traced back
-- without copying the whole search result into a prompt.
WITH raw_candidates AS (
  SELECT
    try_cast(candidate.key AS BIGINT) AS candidate_ordinal,
    candidate.value AS candidate_json
  FROM json_each(CAST(getvariable('candidate_variant_search_json') AS JSON)) candidate
), parsed AS (
  SELECT
    candidate_ordinal,
    json_extract_string(candidate_json, '$.record_kind') AS record_kind,
    json_extract_string(candidate_json, '$.case_id') AS case_id,
    json_extract_string(candidate_json, '$.variant_id') AS declared_variant_id,
    json_extract_string(candidate_json, '$.variant_identifier_scheme') AS declared_variant_identifier_scheme,
    json_extract_string(candidate_json, '$.variant_key') AS variant_key,
    json_extract_string(candidate_json, '$.gene_id') AS gene_id,
    json_extract_string(candidate_json, '$.gene') AS gene,
    try_cast(json_extract(candidate_json, '$.disease_ids') AS VARCHAR[]) AS disease_ids,
    try_cast(json_extract(candidate_json, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank,
    json_extract_string(candidate_json, '$.assembly') AS assembly,
    json_extract_string(candidate_json, '$.chrom') AS chrom,
    try_cast(json_extract(candidate_json, '$.pos') AS BIGINT) AS pos,
    json_extract_string(candidate_json, '$.ref') AS ref,
    json_extract_string(candidate_json, '$.alt') AS alt,
    json_extract_string(candidate_json, '$.search_status') AS search_status,
    list_filter([
      CASE WHEN json_exists(candidate_json, '$.record_kind')
        AND json_type(candidate_json, '$.record_kind') <> 'VARCHAR' THEN 'record_kind' END,
      CASE WHEN json_exists(candidate_json, '$.case_id')
        AND json_type(candidate_json, '$.case_id') <> 'VARCHAR' THEN 'case_id' END,
      CASE WHEN json_exists(candidate_json, '$.variant_id')
        AND json_type(candidate_json, '$.variant_id') NOT IN ('VARCHAR', 'NULL') THEN 'variant_id' END,
      CASE WHEN json_exists(candidate_json, '$.variant_identifier_scheme')
        AND json_type(candidate_json, '$.variant_identifier_scheme') NOT IN ('VARCHAR', 'NULL')
        THEN 'variant_identifier_scheme' END,
      CASE WHEN json_exists(candidate_json, '$.variant_key')
        AND json_type(candidate_json, '$.variant_key') NOT IN ('VARCHAR', 'NULL') THEN 'variant_key' END,
      CASE WHEN json_exists(candidate_json, '$.gene_id')
        AND json_type(candidate_json, '$.gene_id') NOT IN ('VARCHAR', 'NULL') THEN 'gene_id' END,
      CASE WHEN NOT json_exists(candidate_json, '$.disease_ids')
        OR json_type(candidate_json, '$.disease_ids') <> 'ARRAY' THEN 'disease_ids' END,
      CASE WHEN json_exists(candidate_json, '$.disease_ids')
        AND json_type(candidate_json, '$.disease_ids') = 'ARRAY'
        AND coalesce((
          SELECT count(*)
          FROM json_each(json_extract(candidate_json, '$.disease_ids')) disease
          WHERE json_type(disease.value) <> 'VARCHAR'
        ), 0) > 0 THEN 'disease_ids' END,
      CASE WHEN json_exists(candidate_json, '$.hypothesis_rank')
        AND json_type(candidate_json, '$.hypothesis_rank') NOT IN ('BIGINT', 'UBIGINT', 'NULL')
        THEN 'hypothesis_rank' END,
      CASE WHEN json_exists(candidate_json, '$.assembly')
        AND json_type(candidate_json, '$.assembly') NOT IN ('VARCHAR', 'NULL') THEN 'assembly' END,
      CASE WHEN json_exists(candidate_json, '$.chrom')
        AND json_type(candidate_json, '$.chrom') NOT IN ('VARCHAR', 'NULL') THEN 'chrom' END,
      CASE WHEN json_exists(candidate_json, '$.pos')
        AND json_type(candidate_json, '$.pos') NOT IN ('BIGINT', 'UBIGINT', 'NULL') THEN 'pos' END,
      CASE WHEN json_exists(candidate_json, '$.ref')
        AND json_type(candidate_json, '$.ref') NOT IN ('VARCHAR', 'NULL') THEN 'ref' END,
      CASE WHEN json_exists(candidate_json, '$.alt')
        AND json_type(candidate_json, '$.alt') NOT IN ('VARCHAR', 'NULL') THEN 'alt' END,
      CASE WHEN json_exists(candidate_json, '$.search_status')
        AND json_type(candidate_json, '$.search_status') NOT IN ('VARCHAR', 'NULL') THEN 'search_status' END
    ], field -> field IS NOT NULL) AS invalid_type_fields,
    'sha256:' || sha256(CAST(candidate_json AS VARCHAR)) AS candidate_record_digest
  FROM raw_candidates
)
SELECT
  *,
  -- A declared global identifier wins. Otherwise derive a content-addressed,
  -- assembly-pinned local allele identifier from the exact registered fields.
  -- This is deliberately not labelled as GA4GH VRS normalization.
  CASE
    WHEN coalesce(declared_variant_id, '') <> '' THEN declared_variant_id
    WHEN coalesce(assembly, '') <> '' AND coalesce(chrom, '') <> '' AND pos > 0
      AND coalesce(ref, '') <> '' AND coalesce(alt, '') <> ''
      THEN 'urn:pi-bio:allele:sha256:' || sha256(CAST(to_json(struct_pack(
        assembly := assembly,
        chrom := chrom,
        pos := pos,
        ref := ref,
        alt := alt
      )) AS VARCHAR))
  END AS variant_id,
  CASE
    WHEN coalesce(declared_variant_id, '') <> ''
      THEN coalesce(nullif(declared_variant_identifier_scheme, ''), 'declared')
    ELSE 'pi-bio.assembly-allele.v1'
  END AS variant_identifier_scheme,
  getvariable('candidate_variant_search_run_id')::VARCHAR AS candidate_run_id,
  getvariable('candidate_variant_search_result_digest')::VARCHAR AS candidate_result_digest
FROM parsed
WHERE record_kind = 'variant' OR record_kind IS NULL OR record_kind <> 'coverage'
