-- Validate source-pinned SVCv4 Case payloads before any CLN scoring method sees
-- them. This operation implements the public capture/applicability contract,
-- not the unpublished CSpec scoring rules. It therefore returns audit states
-- and issue paths, never points or a classification.
WITH contract_policy AS (
  SELECT
    policy.*,
    source.source_status::VARCHAR AS contract_source_status,
    source.source_digest::VARCHAR AS contract_source_digest
  FROM svcv4_case_contract_policy policy
  LEFT JOIN svcv4_sources source USING (source_id)
  WHERE policy.policy_status = 'active'
), scoped_cases AS (
  SELECT
    coalesce(p.scope_id, c.scope_id) AS scope_id,
    p.* EXCLUDE (scope_id),
    c.scope_id AS observation_scope_id,
    c.observation_ordinal,
    c.observation_ordinal IS NOT NULL AS observation_present,
    CASE
      WHEN c.observation_ordinal IS NOT NULL
        THEN '__observation__:' || c.observation_ordinal::VARCHAR
          || ':scope:' || coalesce(c.scope_id, '<missing>')
      ELSE '__scope__:' || coalesce(p.scope_id, '<missing>')
    END AS audit_key,
    c.item_id,
    c.case_id AS observation_case_id,
    c.workflow,
    CASE c.workflow
      WHEN 'CLN_AFF' THEN 'CLN_AFF'
      WHEN 'CLN_DNV' THEN 'CLN_DNV'
      WHEN 'CLN_ALTV' THEN 'CLN_ALT'
      WHEN 'CLN_ALTG' THEN 'CLN_ALT'
      WHEN 'CLN_UAF' THEN 'CLN_UAF'
    END AS method_code,
    c.admission_state,
    c.case_json,
    c.case_field_state,
    c.source_id,
    c.source_version,
    c.source_uri,
    c.source_digest,
    c.observed_at,
    cp.contract_id::VARCHAR AS contract_id,
    cp.contract_version::VARCHAR AS contract_version,
    cp.contract_definition_digest::VARCHAR AS contract_definition_digest,
    cp.source_id::VARCHAR AS contract_source_id,
    cp.contract_source_status,
    cp.contract_source_digest
  FROM svcv4_profile_selection p
  FULL OUTER JOIN svcv4_case_observations c
    ON c.scope_id = p.scope_id
  LEFT JOIN contract_policy cp
    ON cp.profile_id = p.profile_id
   AND cp.profile_version = p.profile_version
), item_counts AS (
  SELECT item_id, count(*)::INTEGER AS item_count
  FROM svcv4_case_observations
  WHERE item_id IS NOT NULL
  GROUP BY item_id
), object_instances AS (
  -- Every object is audited against one field scope. Nested arrays become one
  -- object row per item so a single valid child cannot mask malformed siblings.
  SELECT s.*, 'case'::VARCHAR AS field_scope, 'case'::VARCHAR AS object_ref, s.case_json AS object_json
  FROM scoped_cases s
  WHERE s.profile_id IS NOT NULL AND s.observation_present AND s.case_field_state = 'object'
  UNION ALL
  SELECT s.*, 'proband', 'case_proband_info', json_extract(s.case_json, '$.case_proband_info')
  FROM scoped_cases s
  WHERE s.profile_id IS NOT NULL AND json_type(s.case_json, '$.case_proband_info') = 'OBJECT'
  UNION ALL
  SELECT s.*, 'age', 'case_proband_info.age', json_extract(s.case_json, '$.case_proband_info.age')
  FROM scoped_cases s
  WHERE s.profile_id IS NOT NULL AND json_type(s.case_json, '$.case_proband_info.age') = 'OBJECT'
  UNION ALL
  SELECT s.*, 'vbc', 'vbc', json_extract(s.case_json, '$.vbc')
  FROM scoped_cases s
  WHERE s.profile_id IS NOT NULL AND json_type(s.case_json, '$.vbc') = 'OBJECT'
  UNION ALL
  SELECT s.*, 'compound_het', 'compound_het_variant', json_extract(s.case_json, '$.compound_het_variant')
  FROM scoped_cases s
  WHERE s.profile_id IS NOT NULL AND json_type(s.case_json, '$.compound_het_variant') = 'OBJECT'
  UNION ALL
  SELECT s.*, 'additional_variant', 'additional_variants[' || av.key || ']', av.value
  FROM scoped_cases s,
    json_each(coalesce(json_extract(s.case_json, '$.additional_variants'), '[]'::JSON)) av
  WHERE s.profile_id IS NOT NULL AND json_type(av.value) = 'OBJECT'
  UNION ALL
  SELECT s.*, 'gene', 'additional_variants[' || av.key || '].gene', json_extract(av.value, '$.gene')
  FROM scoped_cases s,
    json_each(coalesce(json_extract(s.case_json, '$.additional_variants'), '[]'::JSON)) av
  WHERE s.profile_id IS NOT NULL AND json_type(av.value, '$.gene') = 'OBJECT'
  UNION ALL
  SELECT s.*, 'phenotype', 'case_proband_info.phenotypes[' || ph.key || ']', ph.value
  FROM scoped_cases s,
    json_each(coalesce(json_extract(s.case_json, '$.case_proband_info.phenotypes'), '[]'::JSON)) ph
  WHERE s.profile_id IS NOT NULL AND json_type(ph.value) = 'OBJECT'
), applicable_policy_base AS (
  SELECT
    o.*,
    a.field_path::VARCHAR AS field_path,
    CASE o.workflow
      WHEN 'CLN_AFF' THEN a.cln_aff
      WHEN 'CLN_DNV' THEN a.cln_dnv
      WHEN 'CLN_ALTV' THEN a.cln_altv
      WHEN 'CLN_ALTG' THEN a.cln_altg
      WHEN 'CLN_UAF' THEN a.cln_uaf
    END::VARCHAR AS applicability,
    a.value_kind::VARCHAR AS value_kind,
    nullif(a.rule_kind::VARCHAR, '') AS rule_kind,
    nullif(a.rule_value::VARCHAR, '') AS rule_value
  FROM object_instances o
  JOIN svcv4_case_applicability a
    ON a.profile_id = o.profile_id
   AND a.profile_version = o.profile_version
   AND a.field_scope = o.field_scope
), applicable_policy AS (
  SELECT
    * EXCLUDE (applicability),
    CASE
      -- The matrix marks the compound-het object and all of its children as
      -- conditional on a biallelic affected evaluation with a heterozygous
      -- VBC. Once that context is true, every child inherits requiredness.
      WHEN applicability = 'c'
        AND field_scope = 'compound_het'
        AND workflow = 'CLN_AFF'
        AND moi = 'AR'
        AND json_extract_string(case_json, '$.vbc.zygosity') = 'HET'
        THEN 'r'
      ELSE applicability
    END AS applicability
  FROM applicable_policy_base
), policy_issue_candidates AS (
  SELECT
    audit_key,
    CASE
      WHEN applicability = 'r' AND NOT json_exists(object_json, field_path)
        THEN 'incomplete:required_field_missing:' || object_ref || substr(field_path, 2)
      WHEN applicability = 'r' AND json_type(object_json, field_path) = 'NULL'
        THEN 'incomplete:required_field_null:' || object_ref || substr(field_path, 2)
      WHEN applicability = 'x' AND json_exists(object_json, field_path)
        THEN 'invalid:not_applicable_field_present:' || object_ref || substr(field_path, 2)
      WHEN json_exists(object_json, field_path) AND json_type(object_json, field_path) <> 'NULL'
        AND (
          (value_kind = 'string' AND json_type(object_json, field_path) <> 'VARCHAR')
          OR (value_kind = 'object' AND json_type(object_json, field_path) <> 'OBJECT')
          OR (value_kind = 'array' AND json_type(object_json, field_path) <> 'ARRAY')
          OR (value_kind = 'number'
            AND json_type(object_json, field_path) NOT IN ('BIGINT', 'UBIGINT', 'DOUBLE'))
        )
        THEN 'invalid:field_type_mismatch:' || object_ref || substr(field_path, 2)
      WHEN rule_kind = 'fixed'
        AND json_exists(object_json, field_path) AND json_type(object_json, field_path) <> 'NULL'
        AND json_extract_string(object_json, field_path) IS DISTINCT FROM rule_value
        THEN 'invalid:fixed_value_mismatch:' || object_ref || substr(field_path, 2)
      WHEN rule_kind = 'enum_exclude'
        AND workflow = 'CLN_ALTG'
        AND json_extract_string(object_json, field_path) = rule_value
        THEN 'invalid:excluded_enum_value:' || object_ref || substr(field_path, 2)
    END AS issue
  FROM applicable_policy
), policy_issues AS (
  SELECT audit_key, issue
  FROM policy_issue_candidates
  WHERE issue IS NOT NULL
), unknown_field_issues AS (
  -- Upstream Case objects use extra=forbid. Drive the allowed key set from the
  -- same applicability table rather than maintaining another list in SQL.
  SELECT
    o.audit_key,
    'invalid:unknown_field:' || o.object_ref || '.' || fields.key AS issue
  FROM object_instances o,
    json_each(o.object_json) fields
  WHERE NOT EXISTS (
    SELECT 1
    FROM svcv4_case_applicability a
    WHERE a.profile_id = o.profile_id
      AND a.profile_version = o.profile_version
      AND a.field_scope = o.field_scope
      AND a.field_path = '$.' || fields.key
  )
), envelope_issues AS (
  SELECT
    s.audit_key,
    unnest(list_filter([
      CASE WHEN NOT s.observation_present THEN 'incomplete:case_observation_missing' END,
      CASE WHEN s.observation_present AND coalesce(s.item_id, '') = '' THEN 'invalid:item_id_missing' END,
      CASE WHEN s.observation_present AND coalesce(s.observation_scope_id, '') = ''
        THEN 'invalid:scope_id_missing' END,
      CASE WHEN s.observation_present AND s.evaluation_mode IS NULL
        THEN 'invalid:scope_not_requested' END,
      CASE WHEN s.observation_present AND coalesce(ic.item_count, 0) > 1 THEN 'invalid:duplicate_item_id' END,
      CASE WHEN s.evaluation_mode IS NOT NULL AND s.selection_status <> 'selected'
        THEN 'incomplete:profile_' || s.selection_status END,
      CASE WHEN s.evaluation_mode = 'case_conditioned' AND coalesce(s.case_id, '') = ''
        THEN 'invalid:scope_case_id_missing' END,
      CASE WHEN s.observation_present AND s.evaluation_mode <> 'case_conditioned'
        THEN 'invalid:case_observation_on_case_independent_scope' END,
      CASE WHEN s.observation_present AND coalesce(s.workflow, '') = '' THEN 'invalid:workflow_missing' END,
      CASE WHEN s.observation_present AND s.workflow IS NOT NULL
        AND s.workflow NOT IN ('CLN_AFF', 'CLN_DNV', 'CLN_ALTV', 'CLN_ALTG', 'CLN_UAF')
        THEN 'invalid:unsupported_workflow' END,
      CASE WHEN s.observation_present AND s.method_code IS NOT NULL
        AND NOT list_contains(s.expected_method_codes, s.method_code)
        THEN 'invalid:workflow_method_not_expected' END,
      CASE WHEN s.observation_present AND coalesce(s.observation_case_id, '') = '' THEN 'invalid:case_id_missing' END,
      CASE WHEN s.observation_present AND s.case_id IS NOT NULL
        AND s.observation_case_id IS DISTINCT FROM s.case_id THEN 'invalid:case_id_mismatch' END,
      CASE WHEN s.observation_present AND s.admission_state <> 'accepted'
        THEN 'invalid:case_evidence_not_admitted' END,
      CASE WHEN s.observation_present AND s.case_field_state <> 'object'
        THEN 'invalid:case_payload_not_object:' || s.case_field_state END,
      CASE WHEN s.observation_present AND (coalesce(s.source_id, '') = '' OR coalesce(s.source_version, '') = ''
        OR coalesce(s.source_uri, '') = '' OR coalesce(s.observed_at, '') = ''
        OR NOT regexp_matches(coalesce(s.source_digest, ''), '^sha256:[0-9a-f]{64}$'))
        THEN 'invalid:incomplete_source_identity' END,
      CASE WHEN s.selection_status = 'selected' AND s.contract_id IS NULL
        THEN 'invalid:case_contract_policy_missing' END,
      CASE WHEN s.contract_id IS NOT NULL AND s.contract_source_status IS NULL
        THEN 'invalid:case_contract_source_missing' END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases s
  LEFT JOIN item_counts ic USING (item_id)
), identity_and_enum_issues AS (
  SELECT
    audit_key,
    unnest(list_filter([
      CASE WHEN upper(json_extract_string(case_json, '$.moi')) NOT IN ('AD', 'AR', 'XLD', 'XLR', 'SD')
        THEN 'invalid:invalid_moi' END,
      CASE WHEN workflow = 'CLN_ALTV' AND upper(json_extract_string(case_json, '$.moi')) IN ('AR', 'XLR')
        THEN 'invalid:altv_moi_not_supported' END,
      CASE WHEN moi IS NOT NULL AND json_extract_string(case_json, '$.moi') IS NOT NULL
        AND upper(json_extract_string(case_json, '$.moi')) IS DISTINCT FROM moi
        THEN 'invalid:scope_moi_mismatch' END,
      CASE WHEN variant_id IS NOT NULL AND json_extract_string(case_json, '$.vbc.id') IS NOT NULL
        AND json_extract_string(case_json, '$.vbc.id') IS DISTINCT FROM variant_id
        THEN 'invalid:scope_variant_mismatch' END,
      CASE WHEN json_extract_string(case_json, '$.vbc.zygosity') NOT IN ('HOM', 'HET', 'HEMI')
        THEN 'invalid:invalid_vbc_zygosity' END,
      CASE WHEN json_exists(case_json, '$.pop_frq_points')
        AND (try_cast(json_extract(case_json, '$.pop_frq_points') AS DOUBLE) IS NULL
          OR try_cast(json_extract(case_json, '$.pop_frq_points') AS DOUBLE) < -1)
        THEN 'invalid:invalid_pop_frq_points' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.sex') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.sex') NOT IN ('M', 'F', 'U', 'T')
        THEN 'invalid:invalid_proband_sex' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.pheno_specificity_for_gene') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.pheno_specificity_for_gene')
          NOT IN ('SPECIFIC', 'CONSISTENT', 'INCONSISTENT')
        THEN 'invalid:invalid_phenotype_specificity' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.pheno_severity') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.pheno_severity')
          NOT IN ('MONO_GT_OR_BIALLELIC_EQ_EXPECTED', 'MONO_EQ_EXPECTED', 'BIALLELIC_LT_EXPECTED')
        THEN 'invalid:invalid_phenotype_severity' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.age_matched_penetrance') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.age_matched_penetrance')
          NOT IN ('LT_80', 'PCT_80_100', 'NEAR_100')
        THEN 'invalid:invalid_age_matched_penetrance' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.confirmed_parental_relationship') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.confirmed_parental_relationship')
          NOT IN ('TRUE', 'FALSE', 'UNKNOWN')
        THEN 'invalid:invalid_parental_relationship_state' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.all_relevant_genes_tested') IS NOT NULL
        AND json_extract_string(case_json, '$.case_proband_info.all_relevant_genes_tested')
          NOT IN ('TRUE', 'FALSE', 'UNKNOWN')
        THEN 'invalid:invalid_all_genes_tested_state' END,
      CASE WHEN json_extract_string(case_json, '$.additional_variant_exists') IS NOT NULL
        AND json_extract_string(case_json, '$.additional_variant_exists') NOT IN ('TRUE', 'FALSE', 'UNKNOWN')
        THEN 'invalid:invalid_additional_variant_state' END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases
  WHERE profile_id IS NOT NULL AND observation_present AND case_field_state = 'object'
), container_issues AS (
  SELECT
    audit_key,
    unnest(list_filter([
      CASE WHEN json_exists(case_json, '$.additional_variants')
        AND json_type(case_json, '$.additional_variants') <> 'ARRAY'
        THEN 'invalid:additional_variants_not_array' END,
      CASE WHEN workflow IN ('CLN_ALTV', 'CLN_ALTG')
        AND json_extract_string(case_json, '$.additional_variant_exists') IS DISTINCT FROM 'TRUE'
        THEN 'incomplete:alternate_cause_variant_not_confirmed' END,
      CASE WHEN workflow IN ('CLN_ALTV', 'CLN_ALTG')
        AND coalesce(json_array_length(case_json, '$.additional_variants'), 0) = 0
        THEN 'incomplete:alternate_cause_variant_missing' END,
      CASE WHEN workflow = 'CLN_AFF'
        AND json_extract_string(case_json, '$.additional_variant_exists') = 'TRUE'
        AND coalesce(json_array_length(case_json, '$.additional_variants'), 0) = 0
        THEN 'incomplete:declared_additional_variant_missing' END,
      CASE WHEN workflow = 'CLN_AFF'
        AND json_extract_string(case_json, '$.additional_variant_exists') IN ('FALSE', 'UNKNOWN')
        AND coalesce(json_array_length(case_json, '$.additional_variants'), 0) > 0
        THEN 'invalid:additional_variant_state_conflict' END,
      CASE WHEN workflow = 'CLN_AFF' AND upper(json_extract_string(case_json, '$.moi')) = 'AR'
        AND json_extract_string(case_json, '$.vbc.zygosity') = 'HET'
        AND coalesce(json_type(case_json, '$.compound_het_variant'), 'MISSING') <> 'OBJECT'
        THEN 'incomplete:compound_het_context_missing' END,
      CASE WHEN workflow = 'CLN_AFF'
        AND json_type(case_json, '$.compound_het_variant') = 'OBJECT'
        AND NOT (upper(json_extract_string(case_json, '$.moi')) = 'AR'
          AND json_extract_string(case_json, '$.vbc.zygosity') = 'HET')
        THEN 'invalid:compound_het_context_not_applicable' END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases
  WHERE profile_id IS NOT NULL AND observation_present AND case_field_state = 'object'
), additional_variant_issues AS (
  SELECT
    s.audit_key,
    unnest(list_filter([
      CASE WHEN json_type(av.value) <> 'OBJECT' THEN 'invalid:additional_variant_not_object:' || av.key END,
      CASE WHEN json_type(av.value) = 'OBJECT'
        AND json_extract_string(av.value, '$.zygosity') NOT IN ('HOM', 'HET', 'HEMI')
        THEN 'invalid:invalid_additional_variant_zygosity:' || av.key END,
      CASE WHEN json_extract_string(av.value, '$.phase_in_ref_to_vbc') IS NOT NULL
        AND json_extract_string(av.value, '$.phase_in_ref_to_vbc') NOT IN ('TRANS', 'CIS', 'UNKNOWN')
        THEN 'invalid:invalid_additional_variant_phase:' || av.key END,
      CASE WHEN json_extract_string(av.value, '$.phase_confidence') IS NOT NULL
        AND json_extract_string(av.value, '$.phase_confidence') NOT IN ('HIGH', 'MED', 'LOW')
        THEN 'invalid:invalid_additional_variant_phase_confidence:' || av.key END,
      CASE WHEN s.workflow IN ('CLN_ALTV', 'CLN_ALTG')
        AND upper(replace(coalesce(json_extract_string(av.value, '$.classification'), ''), ' ', '_'))
          NOT IN ('P', 'LP', 'PATHOGENIC', 'LIKELY_PATHOGENIC')
        THEN 'invalid:alternate_variant_not_pathogenic_or_likely_pathogenic:' || av.key END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases s,
    json_each(coalesce(json_extract(s.case_json, '$.additional_variants'), '[]'::JSON)) av
  WHERE s.profile_id IS NOT NULL AND s.observation_present
), compound_het_issues AS (
  SELECT
    audit_key,
    unnest(list_filter([
      CASE WHEN json_extract_string(case_json, '$.compound_het_variant.phase_confidence') IS NOT NULL
        AND json_extract_string(case_json, '$.compound_het_variant.phase_confidence') NOT IN ('HIGH', 'MED', 'LOW')
        THEN 'invalid:invalid_compound_het_phase_confidence' END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases
  WHERE profile_id IS NOT NULL AND observation_present AND case_field_state = 'object'
), age_issues AS (
  SELECT
    audit_key,
    unnest(list_filter([
      CASE WHEN json_type(case_json, '$.case_proband_info.age') IS NOT NULL
        AND json_type(case_json, '$.case_proband_info.age') <> 'OBJECT'
        THEN 'invalid:age_not_object' END,
      CASE WHEN json_type(case_json, '$.case_proband_info.age') = 'OBJECT'
        AND json_extract_string(case_json, '$.case_proband_info.age.qualifier')
          NOT IN ('EXACT', 'GT', 'LT', 'APPROX', 'RANGE')
        THEN 'invalid:invalid_age_qualifier' END,
      CASE WHEN json_type(case_json, '$.case_proband_info.age') = 'OBJECT'
        AND json_extract_string(case_json, '$.case_proband_info.age.unit')
          NOT IN ('DAY', 'WEEK', 'MONTH', 'YEAR')
        THEN 'invalid:invalid_age_unit' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.age.qualifier') = 'RANGE'
        AND (try_cast(json_extract(case_json, '$.case_proband_info.age.min') AS DOUBLE) IS NULL
          OR try_cast(json_extract(case_json, '$.case_proband_info.age.max') AS DOUBLE) IS NULL
          OR try_cast(json_extract(case_json, '$.case_proband_info.age.min') AS DOUBLE) < 0
          OR try_cast(json_extract(case_json, '$.case_proband_info.age.max') AS DOUBLE)
            < try_cast(json_extract(case_json, '$.case_proband_info.age.min') AS DOUBLE)
          OR json_type(case_json, '$.case_proband_info.age.value') <> 'NULL')
        THEN 'invalid:invalid_age_range' END,
      CASE WHEN json_extract_string(case_json, '$.case_proband_info.age.qualifier') IN ('EXACT', 'GT', 'LT', 'APPROX')
        AND (try_cast(json_extract(case_json, '$.case_proband_info.age.value') AS DOUBLE) IS NULL
          OR try_cast(json_extract(case_json, '$.case_proband_info.age.value') AS DOUBLE) < 0
          OR json_type(case_json, '$.case_proband_info.age.min') <> 'NULL'
          OR json_type(case_json, '$.case_proband_info.age.max') <> 'NULL')
        THEN 'invalid:invalid_age_value' END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases
  WHERE profile_id IS NOT NULL AND observation_present AND case_field_state = 'object'
), phenotype_issues AS (
  SELECT
    s.audit_key,
    unnest(list_filter([
      CASE WHEN json_type(ph.value) <> 'OBJECT' THEN 'invalid:phenotype_not_object:' || ph.key END,
      CASE WHEN json_type(ph.value) = 'OBJECT'
        AND coalesce(json_extract_string(ph.value, '$.code'), '') = ''
        AND coalesce(json_extract_string(ph.value, '$.name'), '') = ''
        THEN 'incomplete:phenotype_without_code_or_name:' || ph.key END,
      CASE WHEN coalesce(json_extract_string(ph.value, '$.code'), '') <> ''
        AND NOT regexp_matches(json_extract_string(ph.value, '$.code'), '^HP:[0-9]{7}$')
        THEN 'invalid:invalid_hpo_identifier:' || ph.key END
    ], issue -> issue IS NOT NULL)) AS issue
  FROM scoped_cases s,
    json_each(coalesce(json_extract(s.case_json, '$.case_proband_info.phenotypes'), '[]'::JSON)) ph
  WHERE s.profile_id IS NOT NULL AND s.observation_present
), all_issues AS (
  SELECT * FROM envelope_issues
  UNION ALL SELECT * FROM policy_issues
  UNION ALL SELECT * FROM unknown_field_issues
  UNION ALL SELECT * FROM identity_and_enum_issues
  UNION ALL SELECT * FROM container_issues
  UNION ALL SELECT * FROM additional_variant_issues
  UNION ALL SELECT * FROM compound_het_issues
  UNION ALL SELECT * FROM age_issues
  UNION ALL SELECT * FROM phenotype_issues
), issue_summary AS (
  SELECT
    audit_key,
    count(*) FILTER (WHERE starts_with(issue, 'invalid:'))::INTEGER AS invalid_issue_count,
    count(*) FILTER (WHERE starts_with(issue, 'incomplete:'))::INTEGER AS incomplete_issue_count,
    list_sort(list_distinct(list(issue))) AS issues
  FROM all_issues
  GROUP BY audit_key
)
SELECT
  s.scope_id,
  s.item_id,
  s.observation_case_id AS case_id,
  s.variant_id,
  s.gene_id,
  s.disease_id,
  s.moi,
  s.workflow,
  s.method_code,
  s.profile_id,
  s.profile_version,
  CASE
    WHEN coalesce(i.invalid_issue_count, 0) > 0 THEN 'invalid'
    WHEN coalesce(i.incomplete_issue_count, 0) > 0 THEN 'incomplete'
    ELSE 'complete'
  END AS audit_status,
  coalesce(i.invalid_issue_count, 0) AS invalid_issue_count,
  coalesce(i.incomplete_issue_count, 0) AS incomplete_issue_count,
  coalesce(i.issues, []::VARCHAR[]) AS issues,
  s.source_id,
  s.source_version,
  s.source_uri,
  s.source_digest,
  s.observed_at,
  s.contract_id,
  s.contract_version,
  s.contract_definition_digest,
  s.contract_source_id,
  s.contract_source_status,
  s.contract_source_digest
FROM scoped_cases s
LEFT JOIN issue_summary i USING (audit_key)
ORDER BY s.scope_id, s.item_id
