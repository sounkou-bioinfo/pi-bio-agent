-- Audit normalized annotation observations against the exact registered
-- alleles. Admission is variant-wide: one malformed or inconsistent row keeps
-- every transcript for that allele out of downstream evidence relations.
WITH registration_ranked AS (
  SELECT
    *,
    CASE
      WHEN coalesce(variant_key, '') <> '' THEN 'variant:' || variant_key
      ELSE 'registration:' || registration_ordinal::VARCHAR
    END AS audit_key,
    count(*) OVER (PARTITION BY variant_key)::INTEGER AS registration_record_count,
    row_number() OVER (PARTITION BY variant_key ORDER BY registration_ordinal)::INTEGER AS registration_rank
  FROM registered_annotation_variants
), registrations AS (
  SELECT *
  FROM registration_ranked
  WHERE registration_rank = 1
), item_counts AS (
  SELECT item_id, count(*)::INTEGER AS item_count
  FROM variant_annotation_observations
  WHERE item_id IS NOT NULL
  GROUP BY item_id
), observation_rows AS (
  SELECT
    o.*,
    coalesce(i.item_count, 0) AS item_count,
    CASE
      WHEN coalesce(o.variant_key, '') <> '' THEN 'variant:' || o.variant_key
      ELSE 'observation:' || o.observation_ordinal::VARCHAR
    END AS observation_audit_key
  FROM variant_annotation_observations o
  LEFT JOIN item_counts i USING (item_id)
), joined_raw AS (
  SELECT
    coalesce(r.audit_key, o.observation_audit_key) AS audit_key,
    r.registration_ordinal,
    r.registration_record_count,
    r.case_id AS registered_case_id,
    r.variant_id AS registered_variant_id,
    r.variant_key AS registered_variant_key,
    r.assembly AS registered_assembly,
    r.chrom AS registered_chrom,
    r.pos AS registered_pos,
    r.ref AS registered_ref,
    r.alt AS registered_alt,
    r.unknown_fields AS registration_unknown_fields,
    r.invalid_type_fields AS registration_invalid_type_fields,
    o.* EXCLUDE (observation_audit_key),
    r.registration_ordinal IS NOT NULL AS registration_present,
    o.observation_ordinal IS NOT NULL AS observation_present
  FROM registrations r
  FULL OUTER JOIN observation_rows o
    ON coalesce(r.variant_key, '') <> ''
   AND o.variant_key = r.variant_key
), audit_summary AS (
  SELECT
    audit_key,
    count(*) FILTER (WHERE observation_present)::INTEGER AS observation_count,
    count(*) FILTER (WHERE record_kind = 'coverage')::INTEGER AS coverage_count,
    count(*) FILTER (
      WHERE record_kind = 'coverage' AND annotation_state = 'completed'
    )::INTEGER AS completed_coverage_count,
    count(*) FILTER (
      WHERE record_kind = 'coverage' AND annotation_state = 'response_missing'
    )::INTEGER AS missing_response_count,
    count(*) FILTER (WHERE record_kind = 'transcript_consequence')::INTEGER AS emitted_transcript_count,
    max(transcript_count) FILTER (WHERE record_kind = 'coverage')::INTEGER AS declared_transcript_count,
    count(DISTINCT concat_ws('|', source_id, source_version, source_uri,
      coalesce(source_digest, '<null>'), observed_at)) FILTER (WHERE observation_present)::INTEGER AS source_snapshot_count
  FROM joined_raw
  GROUP BY audit_key
), joined AS (
  SELECT j.*, s.* EXCLUDE (audit_key)
  FROM joined_raw j
  JOIN audit_summary s USING (audit_key)
), issue_lists AS (
  SELECT
    *,
    list_filter([
      CASE WHEN registration_present AND registration_record_count > 1
        THEN 'invalid:duplicate_variant_registration' END,
      CASE WHEN registration_present AND len(registration_unknown_fields) > 0
        THEN 'invalid:unknown_registration_fields' END,
      CASE WHEN registration_present AND len(registration_invalid_type_fields) > 0
        THEN 'invalid:registration_field_types' END,
      CASE WHEN registration_present AND coalesce(registered_variant_key, '') = ''
        THEN 'invalid:missing_registered_variant_key' END,
      CASE WHEN registration_present AND coalesce(registered_assembly, '') = ''
        THEN 'invalid:missing_registered_assembly' END,
      CASE WHEN registration_present AND coalesce(registered_chrom, '') = ''
        THEN 'invalid:missing_registered_chrom' END,
      CASE WHEN registration_present AND registered_pos IS NULL
        THEN 'invalid:missing_registered_pos' END,
      CASE WHEN registration_present AND registered_pos < 1
        THEN 'invalid:registered_pos_out_of_range' END,
      CASE WHEN registration_present AND coalesce(registered_ref, '') = ''
        THEN 'invalid:missing_registered_ref' END,
      CASE WHEN registration_present AND coalesce(registered_alt, '') = ''
        THEN 'invalid:missing_registered_alt' END,
      CASE WHEN registration_present AND NOT observation_present
        THEN 'incomplete:annotation_observation_missing' END,
      CASE WHEN observation_present AND NOT registration_present
        THEN 'invalid:unregistered_annotation_observation' END,
      CASE WHEN observation_present AND len(unknown_fields) > 0
        THEN 'invalid:unknown_observation_fields' END,
      CASE WHEN observation_present AND len(invalid_type_fields) > 0
        THEN 'invalid:observation_field_types' END,
      CASE WHEN observation_present AND invalid_consequence_term_type_count > 0
        THEN 'invalid:consequence_term_types' END,
      CASE WHEN observation_present AND coalesce(item_id, '') = ''
        THEN 'invalid:missing_item_id' END,
      CASE WHEN observation_present AND item_count > 1
        THEN 'invalid:duplicate_item_id' END,
      CASE WHEN observation_present AND record_kind NOT IN (
        'coverage', 'transcript_consequence', 'orphan_response'
      ) THEN 'invalid:unsupported_record_kind' END,
      CASE WHEN record_kind = 'coverage' AND annotation_state NOT IN ('completed', 'response_missing')
        THEN 'invalid:coverage_annotation_state' END,
      CASE WHEN record_kind = 'transcript_consequence' AND annotation_state <> 'observed'
        THEN 'invalid:transcript_annotation_state' END,
      CASE WHEN record_kind = 'orphan_response' AND annotation_state <> 'unregistered_response'
        THEN 'invalid:orphan_annotation_state' END,
      CASE WHEN observation_present AND admission_state NOT IN ('accepted', 'proposed', 'rejected')
        THEN 'invalid:unsupported_admission_state' END,
      CASE WHEN observation_present AND admission_state <> 'accepted' AND record_kind <> 'orphan_response'
        THEN 'incomplete:observation_not_admitted' END,
      CASE WHEN record_kind = 'orphan_response'
        THEN 'invalid:orphan_provider_response' END,
      CASE WHEN observation_present AND coalesce(variant_key, '') = ''
        THEN 'invalid:missing_observation_variant_key' END,
      CASE WHEN registration_present AND observation_present
        AND variant_key <> registered_variant_key THEN 'invalid:variant_key_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND coalesce(source_variant_key, '') <> registered_variant_key
        THEN 'invalid:source_variant_key_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND lower(coalesce(assembly, '')) <> lower(registered_assembly)
        THEN 'invalid:assembly_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND coalesce(chrom, '') <> registered_chrom THEN 'invalid:chrom_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND pos IS DISTINCT FROM registered_pos THEN 'invalid:pos_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND coalesce(ref, '') <> registered_ref THEN 'invalid:ref_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND coalesce(alt, '') <> registered_alt THEN 'invalid:alt_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND registered_variant_id IS NOT NULL AND variant_id IS NOT NULL
        AND variant_id <> registered_variant_id THEN 'invalid:variant_id_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND registered_case_id IS NOT NULL AND case_id IS NOT NULL
        AND case_id <> registered_case_id THEN 'invalid:case_id_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND reported_assembly IS NOT NULL
        AND lower(reported_assembly) <> lower(registered_assembly)
        THEN 'invalid:reported_assembly_mismatch' END,
      CASE WHEN registration_present AND observation_present
        AND reported_chrom IS NOT NULL
        AND regexp_replace(reported_chrom, '^chr', '', 'i') <> registered_chrom
        THEN 'invalid:reported_chrom_mismatch' END,
      CASE WHEN observation_present AND coalesce(source_id, '') = ''
        THEN 'invalid:missing_source_id' END,
      CASE WHEN observation_present AND coalesce(source_version, '') = ''
        THEN 'invalid:missing_source_version' END,
      CASE WHEN observation_present AND coalesce(source_uri, '') = ''
        THEN 'invalid:missing_source_uri' END,
      CASE WHEN observation_present AND coalesce(observed_at, '') = ''
        THEN 'invalid:missing_observed_at' END,
      CASE WHEN observation_present AND observed_at IS NOT NULL
        AND try_cast(observed_at AS TIMESTAMPTZ) IS NULL THEN 'invalid:observed_at_format' END,
      CASE WHEN observation_present AND annotation_state <> 'response_missing'
        AND NOT regexp_full_match(coalesce(source_digest, ''), 'sha256:[0-9a-fA-F]{64}')
        THEN 'invalid:source_digest' END,
      CASE WHEN record_kind = 'coverage' AND annotation_state = 'completed'
        AND (transcript_count IS NULL OR transcript_count < 0)
        THEN 'invalid:coverage_transcript_count' END,
      CASE WHEN record_kind = 'transcript_consequence'
        AND (transcript_count IS NULL OR transcript_count < 1)
        THEN 'invalid:transcript_count' END,
      CASE WHEN record_kind = 'transcript_consequence' AND coalesce(gene_id, '') = ''
        THEN 'invalid:missing_gene_id' END,
      CASE WHEN record_kind = 'transcript_consequence' AND coalesce(transcript_id, '') = ''
        THEN 'invalid:missing_transcript_id' END,
      CASE WHEN record_kind = 'transcript_consequence'
        AND coalesce(len(consequence_terms), 0) = 0 THEN 'invalid:missing_consequence_terms' END,
      CASE WHEN record_kind = 'transcript_consequence' AND coalesce(impact, '') = ''
        THEN 'invalid:missing_impact' END,
      CASE WHEN coverage_count = 0 AND registration_present
        THEN 'incomplete:coverage_observation_missing' END,
      CASE WHEN coverage_count > 1 THEN 'invalid:duplicate_coverage_observation' END,
      CASE WHEN source_snapshot_count > 1 THEN 'invalid:mixed_source_snapshots' END,
      CASE WHEN missing_response_count > 0 THEN 'incomplete:provider_response_missing' END,
      CASE WHEN completed_coverage_count = 1
        AND declared_transcript_count IS DISTINCT FROM emitted_transcript_count
        THEN 'invalid:transcript_count_mismatch' END,
      CASE WHEN record_kind = 'transcript_consequence'
        AND declared_transcript_count IS NOT NULL
        AND transcript_count IS DISTINCT FROM declared_transcript_count
        THEN 'invalid:row_transcript_count_mismatch' END
    ], issue -> issue IS NOT NULL) AS row_issues
  FROM joined
), issue_rows AS (
  SELECT audit_key, issue
  FROM issue_lists, unnest(row_issues) issue_row(issue)
), issues AS (
  SELECT audit_key, list_sort(list_distinct(list(issue))) AS audit_issues
  FROM issue_rows
  GROUP BY audit_key
), audited AS (
  SELECT
    i.* EXCLUDE (row_issues),
    coalesce(x.audit_issues, []::VARCHAR[]) AS audit_issues,
    CASE
      WHEN len(list_filter(
        coalesce(x.audit_issues, []::VARCHAR[]), issue -> starts_with(issue, 'invalid:')
      )) > 0 THEN 'invalid'
      WHEN len(coalesce(x.audit_issues, []::VARCHAR[])) > 0 THEN 'incomplete'
      ELSE 'complete'
    END AS audit_status
  FROM issue_lists i
  LEFT JOIN issues x USING (audit_key)
)
SELECT
  audit_key,
  registration_present,
  observation_present,
  registration_record_count,
  observation_count,
  coverage_count,
  declared_transcript_count,
  emitted_transcript_count,
  source_snapshot_count,
  record_kind,
  annotation_state,
  item_id,
  coalesce(registered_case_id, case_id) AS case_id,
  coalesce(registered_variant_id, variant_id) AS variant_id,
  coalesce(registered_variant_key, variant_key) AS variant_key,
  coalesce(registered_assembly, assembly) AS assembly,
  coalesce(registered_chrom, chrom) AS chrom,
  coalesce(registered_pos, pos) AS pos,
  coalesce(registered_ref, ref) AS ref,
  coalesce(registered_alt, alt) AS alt,
  source_variant_key,
  reported_assembly,
  reported_chrom,
  reported_start,
  reported_end,
  reported_allele_string,
  input,
  source_record_id,
  transcript_count,
  gene_id,
  gene,
  transcript_id,
  transcript_biotype,
  is_canonical,
  mane_select,
  consequence_terms,
  most_severe_consequence,
  impact,
  hgvsc,
  hgvsp,
  source_id,
  source_version,
  source_uri,
  source_digest,
  observed_at,
  admission_state,
  audit_status,
  audit_issues,
  (audit_status = 'complete'
    AND record_kind = 'transcript_consequence'
    AND admission_state = 'accepted') AS evidence_eligible
FROM audited
ORDER BY audit_key, record_kind, gene, transcript_id, observation_ordinal
