SELECT *
FROM monarch_phenotype_hypotheses
ORDER BY hypothesis_rank
LIMIT coalesce(try_cast(getvariable('limit') AS INTEGER), 50)
