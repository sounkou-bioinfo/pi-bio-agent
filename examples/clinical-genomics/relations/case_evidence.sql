WITH evidence_bearing_variant AS (
  SELECT *
  FROM variant_assessment
  WHERE variant_bucket IN ('candidate', 'abstain_no_frequency')
     OR conflict IS NOT NULL
),
direct AS (
  SELECT
    va.case_id,
    'direct' AS lane,
    'variant:' || va.variant_key AS evidence_key,
    va.gene,
    NULL::VARCHAR AS disease_id,
    va.variant_key,
    va.consequence,
    va.allele_frequency,
    va.clinical_significance,
    va.zygosity,
    va.inheritance,
    va.variant_bucket,
    va.variant_status,
    NULL::INTEGER AS matched_observed_terms,
    NULL::INTEGER AS declared_terms_in_resource,
    va.variant_status AS evidence_status,
    va.missing_field,
    va.conflict,
    va.review_kind,
    'variant:' || va.variant_key AS review_target
  FROM evidence_bearing_variant va
),
inverted_with_variant AS (
  SELECT
    ph.case_id,
    'inverted' AS lane,
    'hypothesis:' || ph.disease_id || ':' || ph.gene || ':' || va.variant_key AS evidence_key,
    ph.gene,
    ph.disease_id,
    va.variant_key,
    va.consequence,
    va.allele_frequency,
    va.clinical_significance,
    va.zygosity,
    va.inheritance,
    va.variant_bucket,
    va.variant_status,
    ph.matched_observed_terms,
    ph.declared_terms_in_resource,
    CASE
      WHEN va.variant_bucket = 'candidate' THEN 'genotype_supports_hypothesis'
      WHEN va.variant_bucket = 'abstain_no_frequency' THEN 'hypothesis_variant_abstained'
      ELSE 'variant_conflicts_with_hypothesis'
    END AS evidence_status,
    va.missing_field,
    va.conflict,
    CASE
      WHEN va.variant_bucket = 'candidate' THEN 'correlate_supported_hypothesis'
      ELSE va.review_kind
    END AS review_kind,
    'hypothesis:' || ph.disease_id || ':' || ph.gene AS review_target
  FROM phenotype_hypothesis ph
  JOIN evidence_bearing_variant va
    ON va.case_id = ph.case_id
   AND va.gene = ph.gene
),
inverted_without_support AS (
  SELECT
    ph.case_id,
    'inverted' AS lane,
    'hypothesis:' || ph.disease_id || ':' || ph.gene || ':no-supporting-variant' AS evidence_key,
    ph.gene,
    ph.disease_id,
    NULL::VARCHAR AS variant_key,
    NULL::VARCHAR AS consequence,
    NULL::DOUBLE AS allele_frequency,
    NULL::VARCHAR AS clinical_significance,
    NULL::VARCHAR AS zygosity,
    NULL::VARCHAR AS inheritance,
    NULL::VARCHAR AS variant_bucket,
    NULL::VARCHAR AS variant_status,
    ph.matched_observed_terms,
    ph.declared_terms_in_resource,
    'hypothesis_without_supporting_variant' AS evidence_status,
    'variant_support' AS missing_field,
    NULL::VARCHAR AS conflict,
    'inverted_gap' AS review_kind,
    'hypothesis:' || ph.disease_id || ':' || ph.gene AS review_target
  FROM phenotype_hypothesis ph
  WHERE NOT EXISTS (
    SELECT 1
    FROM evidence_bearing_variant va
    WHERE va.case_id = ph.case_id
      AND va.gene = ph.gene
  )
)
SELECT * FROM direct
UNION ALL
SELECT * FROM inverted_with_variant
UNION ALL
SELECT * FROM inverted_without_support
