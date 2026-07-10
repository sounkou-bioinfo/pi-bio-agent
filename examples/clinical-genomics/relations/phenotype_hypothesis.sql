WITH observed AS (
  SELECT case_id, hpo_id
  FROM grounded_phenotype_observations
  WHERE case_id = getvariable('case_id')
    AND assertion_context = 'present'
    AND subject_context = 'proband'
    AND acceptance_state = 'accepted'
),
matched AS (
  SELECT
    o.case_id,
    gp.gene,
    gp.disease_id,
    gp.validity,
    gp.mode,
    COUNT(DISTINCT o.hpo_id)::INTEGER AS matched_observed_terms
  FROM observed o
  JOIN gene_phenotype gp
    ON gp.hpo_id = o.hpo_id
  GROUP BY o.case_id, gp.gene, gp.disease_id, gp.validity, gp.mode
),
declared AS (
  SELECT
    gene,
    disease_id,
    COUNT(DISTINCT hpo_id)::INTEGER AS declared_terms_in_resource
  FROM gene_phenotype
  GROUP BY gene, disease_id
)
SELECT
  m.case_id,
  m.gene,
  m.disease_id,
  m.validity,
  m.mode,
  m.matched_observed_terms,
  d.declared_terms_in_resource
FROM matched m
JOIN declared d USING (gene, disease_id)
