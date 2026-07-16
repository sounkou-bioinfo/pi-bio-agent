-- Evidence lines are outputs of method evaluators, not free-form model scores.
-- The producer run/result identities let the host bind each row back to ledger
-- and CAS evidence before classification.
SELECT
  json_extract_string(value, '$.line_id') AS line_id,
  json_extract_string(value, '$.scope_id') AS scope_id,
  json_extract_string(value, '$.variant_id') AS variant_id,
  json_extract_string(value, '$.gene_id') AS gene_id,
  json_extract_string(value, '$.disease_id') AS disease_id,
  upper(json_extract_string(value, '$.moi')) AS moi,
  json_extract_string(value, '$.case_id') AS case_id,
  json_extract_string(value, '$.profile_id') AS profile_id,
  json_extract_string(value, '$.profile_version') AS profile_version,
  json_extract_string(value, '$.method_code') AS method_code,
  json_extract_string(value, '$.evaluation_state') AS evaluation_state,
  try_cast(json_extract(value, '$.score') AS DOUBLE) AS score,
  json_extract_string(value, '$.reason_code') AS reason_code,
  coalesce(try_cast(json_extract(value, '$.evidence_item_ids') AS VARCHAR[]), []::VARCHAR[]) AS evidence_item_ids,
  json_extract_string(value, '$.evaluator_id') AS evaluator_id,
  json_extract_string(value, '$.evaluator_version') AS evaluator_version,
  json_extract_string(value, '$.method_definition_digest') AS method_definition_digest,
  json_extract_string(value, '$.producer_run_id') AS producer_run_id,
  json_extract_string(value, '$.producer_result_digest') AS producer_result_digest,
  coalesce(json_extract_string(value, '$.admission_state'), 'proposed') AS admission_state,
  json_extract_string(value, '$.branch_group') AS branch_group,
  json_extract_string(value, '$.branch_id') AS branch_id
FROM json_each(CAST(getvariable('svcv4_evidence_lines_json') AS JSON))
