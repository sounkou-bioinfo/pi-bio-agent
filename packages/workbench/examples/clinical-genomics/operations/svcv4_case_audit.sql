-- Audit captured CLN case inputs; scoring remains a separate CSpec-defined step.
SELECT *
FROM svcv4_case_input_audit
ORDER BY scope_id, item_id
