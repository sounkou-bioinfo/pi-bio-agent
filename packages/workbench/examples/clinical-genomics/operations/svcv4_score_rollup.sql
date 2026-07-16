-- Expose raw and capped values at every configured hierarchy node.
SELECT *
FROM svcv4_score_rollup
ORDER BY scope_id, node_stage, node_code
