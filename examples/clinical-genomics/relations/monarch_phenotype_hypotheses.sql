WITH per_observed_term AS (
  SELECT
    disease_id,
    any_value(disease_label) AS disease_label,
    observed_hpo_id,
    MAX(CASE WHEN match_kind = 'exact' THEN 1 ELSE 0 END)::INTEGER AS exact_match,
    MAX(annotation_information_content) AS specificity,
    COUNT(DISTINCT disease_hpo_id)::INTEGER AS supporting_annotations
  FROM monarch_disease_phenotype_matches
  GROUP BY disease_id, observed_hpo_id
), disease_scores AS (
  SELECT
    disease_id,
    any_value(disease_label) AS disease_label,
    COUNT(DISTINCT observed_hpo_id)::INTEGER AS matched_observed_terms,
    SUM(exact_match)::INTEGER AS exact_observed_terms,
    SUM(specificity) AS phenotype_specificity_score,
    SUM(supporting_annotations)::INTEGER AS supporting_phenotype_annotations
  FROM per_observed_term
  GROUP BY disease_id
), disease_evidence AS (
  SELECT
    disease_id,
    list_sort(list_distinct(list(match_kind))) AS phenotype_match_kinds,
    list_sort(list_distinct(list(primary_knowledge_source) FILTER (
      WHERE primary_knowledge_source IS NOT NULL
    ))) AS phenotype_sources
  FROM monarch_disease_phenotype_matches
  GROUP BY disease_id
), gene_evidence AS (
  SELECT
    gene_id,
    any_value(gene) AS gene,
    disease_id,
    MAX(CASE WHEN predicate = 'biolink:causes' THEN 1 ELSE 0 END)::INTEGER AS has_causal_assertion,
    COUNT(*)::INTEGER AS gene_disease_assertions,
    list_sort(list_distinct(list(predicate))) AS gene_disease_predicates,
    list_sort(list_distinct(list(primary_knowledge_source) FILTER (
      WHERE primary_knowledge_source IS NOT NULL
    ))) AS gene_disease_sources
  FROM monarch_gene_disease_evidence
  GROUP BY gene_id, disease_id
)
SELECT
  g.gene_id,
  g.gene,
  d.disease_id,
  d.disease_label,
  d.matched_observed_terms,
  d.exact_observed_terms,
  d.phenotype_specificity_score,
  d.supporting_phenotype_annotations,
  evidence.phenotype_match_kinds,
  evidence.phenotype_sources,
  g.has_causal_assertion,
  g.gene_disease_assertions,
  g.gene_disease_predicates,
  g.gene_disease_sources,
  ROW_NUMBER() OVER (
    ORDER BY
      d.exact_observed_terms DESC,
      d.matched_observed_terms DESC,
      d.phenotype_specificity_score DESC,
      g.has_causal_assertion DESC,
      g.gene,
      d.disease_id
  )::INTEGER AS hypothesis_rank
FROM disease_scores d
JOIN disease_evidence evidence USING (disease_id)
JOIN gene_evidence g USING (disease_id)
