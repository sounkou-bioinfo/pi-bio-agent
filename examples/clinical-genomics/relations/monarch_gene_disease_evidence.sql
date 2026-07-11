WITH candidate_diseases AS (
  SELECT DISTINCT disease_id
  FROM monarch_disease_phenotype_matches
)
SELECT DISTINCT
  e.subject AS gene_id,
  coalesce(gene.symbol, gene.name, e.subject) AS gene,
  e.object AS disease_id,
  e.predicate,
  e.primary_knowledge_source,
  e.has_evidence,
  e.publications
FROM monarch.edges e
JOIN candidate_diseases candidate
  ON candidate.disease_id = e.object
LEFT JOIN monarch.nodes gene
  ON gene.id = e.subject
WHERE e.subject LIKE 'HGNC:%'
  AND e.predicate IN (
    'biolink:causes',
    'biolink:gene_associated_with_condition',
    'biolink:associated_with_increased_likelihood_of'
  )
  AND coalesce(try_cast(e.negated AS BOOLEAN), false) = false
