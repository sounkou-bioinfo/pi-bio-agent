-- Keep formed and failed paths together in one checkpointed result. The next
-- operation consumes only scope_json from rows whose formation_state is formed;
-- reviewers retain the failure rows and their source identities.
SELECT *
FROM svcv4_scope_formation
ORDER BY
  CASE formation_state WHEN 'formed' THEN 0 ELSE 1 END,
  variant_id,
  gene_id,
  disease_id,
  moi,
  reason_code;
