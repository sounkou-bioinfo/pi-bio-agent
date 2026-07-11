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
    NULL::VARCHAR AS gene_id,
    va.gene,
    NULL::VARCHAR AS disease_id,
    NULL::VARCHAR AS disease_label,
    va.variant_key,
    va.consequence,
    va.allele_frequency,
    va.clinical_significance,
    va.zygosity,
    va.inheritance,
    va.variant_bucket,
    va.variant_status,
    NULL::INTEGER AS matched_observed_terms,
    NULL::INTEGER AS exact_observed_terms,
    NULL::DOUBLE AS phenotype_specificity_score,
    NULL::INTEGER AS supporting_phenotype_annotations,
    NULL::VARCHAR[] AS phenotype_match_kinds,
    NULL::VARCHAR[] AS phenotype_sources,
    NULL::INTEGER AS has_causal_assertion,
    NULL::INTEGER AS gene_disease_assertions,
    NULL::VARCHAR[] AS gene_disease_predicates,
    NULL::VARCHAR[] AS gene_disease_sources,
    NULL::INTEGER AS hypothesis_rank,
    NULL::VARCHAR AS variant_search_status,
    NULL::VARCHAR AS variant_search_scope,
    NULL::VARCHAR AS variant_search_assembly,
    NULL::INTEGER AS searched_variant_count,
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
    ph.gene_id,
    ph.gene,
    ph.disease_id,
    ph.disease_label,
    va.variant_key,
    va.consequence,
    va.allele_frequency,
    va.clinical_significance,
    va.zygosity,
    va.inheritance,
    va.variant_bucket,
    va.variant_status,
    ph.matched_observed_terms,
    ph.exact_observed_terms,
    ph.phenotype_specificity_score,
    ph.supporting_phenotype_annotations,
    ph.phenotype_match_kinds,
    ph.phenotype_sources,
    ph.has_causal_assertion,
    ph.gene_disease_assertions,
    ph.gene_disease_predicates,
    ph.gene_disease_sources,
    ph.hypothesis_rank,
    coverage.search_status AS variant_search_status,
    coverage.search_scope AS variant_search_scope,
    coverage.assembly AS variant_search_assembly,
    try_cast(coverage.searched_variant_count AS INTEGER) AS searched_variant_count,
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
  LEFT JOIN variant_search_coverage coverage
    ON coverage.case_id = ph.case_id
   AND coverage.gene = ph.gene
),
inverted_without_support AS (
  SELECT
    ph.case_id,
    'inverted' AS lane,
    'hypothesis:' || ph.disease_id || ':' || ph.gene || ':no-supporting-variant' AS evidence_key,
    ph.gene_id,
    ph.gene,
    ph.disease_id,
    ph.disease_label,
    NULL::VARCHAR AS variant_key,
    NULL::VARCHAR AS consequence,
    NULL::DOUBLE AS allele_frequency,
    NULL::VARCHAR AS clinical_significance,
    NULL::VARCHAR AS zygosity,
    NULL::VARCHAR AS inheritance,
    NULL::VARCHAR AS variant_bucket,
    NULL::VARCHAR AS variant_status,
    ph.matched_observed_terms,
    ph.exact_observed_terms,
    ph.phenotype_specificity_score,
    ph.supporting_phenotype_annotations,
    ph.phenotype_match_kinds,
    ph.phenotype_sources,
    ph.has_causal_assertion,
    ph.gene_disease_assertions,
    ph.gene_disease_predicates,
    ph.gene_disease_sources,
    ph.hypothesis_rank,
    coverage.search_status AS variant_search_status,
    coverage.search_scope AS variant_search_scope,
    coverage.assembly AS variant_search_assembly,
    try_cast(coverage.searched_variant_count AS INTEGER) AS searched_variant_count,
    CASE
      WHEN coverage.search_status = 'completed' THEN 'hypothesis_without_supporting_variant'
      ELSE 'hypothesis_not_searched'
    END AS evidence_status,
    CASE
      WHEN coverage.search_status = 'completed' THEN 'variant_support'
      ELSE 'variant_search'
    END AS missing_field,
    NULL::VARCHAR AS conflict,
    CASE
      WHEN coverage.search_status = 'completed' THEN 'review_missing_genotype_support'
      ELSE NULL
    END AS review_kind,
    'hypothesis:' || ph.disease_id || ':' || ph.gene AS review_target
  FROM phenotype_hypothesis ph
  LEFT JOIN variant_search_coverage coverage
    ON coverage.case_id = ph.case_id
   AND coverage.gene = ph.gene
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
