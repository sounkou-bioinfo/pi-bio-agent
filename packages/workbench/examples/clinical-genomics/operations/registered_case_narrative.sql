-- The host supplies the exact text from the registered CAS asset as a protected
-- session binding. The value is absent from the manifest and replay object;
-- only its protected-input digest and this operation's result enter the run.
SELECT
  getvariable('case_id')::VARCHAR AS case_id,
  getvariable('case_narrative_text')::VARCHAR AS narrative;
