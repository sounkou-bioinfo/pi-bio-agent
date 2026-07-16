-- Method-by-method coverage, provenance, and structural validation report.
SELECT *
FROM svcv4_line_audit
ORDER BY scope_id, is_expected DESC, method_code, line_id
