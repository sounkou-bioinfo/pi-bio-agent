WITH disease_annotations AS (
  SELECT
    e.subject AS disease_id,
    e.object AS disease_hpo_id,
    e.frequency_qualifier,
    e.primary_knowledge_source,
    e.has_evidence,
    e.publications
  FROM monarch.edges e
  WHERE e.predicate = 'biolink:has_phenotype'
    AND e.subject LIKE 'MONDO:%'
    AND e.object LIKE 'HP:%'
    AND coalesce(try_cast(e.negated AS BOOLEAN), false) = false
), direct_or_broader AS (
  SELECT
    a.observed_hpo_id,
    d.*,
    CASE
      WHEN a.observed_hpo_id = d.disease_hpo_id THEN 'exact'
      ELSE 'observed_descends_from_annotation'
    END AS match_kind
  FROM case_phenotype_ancestors a
  JOIN disease_annotations d
    ON d.disease_hpo_id = a.ancestor_hpo_id
), more_specific AS (
  SELECT
    observed.observed_hpo_id,
    d.*,
    'annotation_descends_from_observed' AS match_kind
  FROM (SELECT DISTINCT observed_hpo_id FROM case_phenotype_ancestors) observed
  JOIN monarch.closure c
    ON c.object_id = observed.observed_hpo_id
   AND c.predicate_id = 'rdfs:subClassOf'
   AND c.subject_id LIKE 'HP:%'
   AND c.subject_id <> observed.observed_hpo_id
  JOIN disease_annotations d
    ON d.disease_hpo_id = c.subject_id
), candidate_matches AS (
  SELECT * FROM direct_or_broader
  UNION ALL
  SELECT * FROM more_specific
), annotation_frequency AS (
  SELECT
    disease_hpo_id,
    COUNT(DISTINCT disease_id)::BIGINT AS annotated_disease_count
  FROM disease_annotations
  GROUP BY disease_hpo_id
), totals AS (
  SELECT COUNT(DISTINCT disease_id)::BIGINT AS total_disease_count
  FROM disease_annotations
)
SELECT
  m.observed_hpo_id,
  m.disease_id,
  disease.name AS disease_label,
  m.disease_hpo_id,
  phenotype.name AS disease_phenotype_label,
  m.match_kind,
  ln((t.total_disease_count + 1.0) / (f.annotated_disease_count + 1.0)) AS annotation_information_content,
  f.annotated_disease_count,
  t.total_disease_count,
  m.frequency_qualifier,
  m.primary_knowledge_source,
  m.has_evidence,
  m.publications
FROM candidate_matches m
JOIN annotation_frequency f USING (disease_hpo_id)
CROSS JOIN totals t
LEFT JOIN monarch.nodes disease ON disease.id = m.disease_id
LEFT JOIN monarch.nodes phenotype ON phenotype.id = m.disease_hpo_id
