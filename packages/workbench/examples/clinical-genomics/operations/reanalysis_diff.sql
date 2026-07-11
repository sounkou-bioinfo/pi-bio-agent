SELECT *
FROM reanalysis_evidence
ORDER BY
  CASE change_status
    WHEN 'upgraded' THEN 0
    WHEN 'new' THEN 1
    WHEN 'downgraded' THEN 2
    WHEN 'dropped' THEN 3
    WHEN 'abstain_unknown_status' THEN 4
    ELSE 5
  END,
  variant_key
