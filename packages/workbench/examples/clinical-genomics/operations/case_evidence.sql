SELECT *
FROM case_evidence
ORDER BY
  lane,
  CASE evidence_status
    WHEN 'curated_plp_candidate' THEN 0
    WHEN 'candidate_needs_review' THEN 1
    WHEN 'genotype_supports_hypothesis' THEN 2
    WHEN 'hypothesis_variant_abstained' THEN 3
    WHEN 'hypothesis_without_supporting_variant' THEN 4
    WHEN 'hypothesis_not_searched' THEN 5
    ELSE 6
  END,
  gene,
  variant_key
