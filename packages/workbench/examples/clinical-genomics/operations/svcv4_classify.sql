-- Final classification is populated only for complete, valid scopes.
SELECT *
FROM svcv4_classification_results
ORDER BY scope_id
