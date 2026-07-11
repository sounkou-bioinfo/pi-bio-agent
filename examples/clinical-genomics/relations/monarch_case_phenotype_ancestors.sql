WITH observed AS (
  SELECT DISTINCT hpo_id
  FROM UNNEST(CAST(getvariable('phenotype_ids') AS VARCHAR[])) AS terms(hpo_id)
), closure_rows AS (
  SELECT
    o.hpo_id AS observed_hpo_id,
    c.object_id AS ancestor_hpo_id
  FROM observed o
  JOIN monarch.closure c
    ON c.subject_id = o.hpo_id
   AND c.predicate_id = 'rdfs:subClassOf'
  WHERE c.object_id LIKE 'HP:%'
)
SELECT observed_hpo_id, ancestor_hpo_id
FROM closure_rows
UNION
SELECT hpo_id, hpo_id
FROM observed
