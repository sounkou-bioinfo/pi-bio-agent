WITH parsed AS (
  SELECT
    json_extract_string(value, '$.caseId') AS case_id,
    json_extract_string(value, '$.hpoId') AS hpo_id,
    json_extract_string(value, '$.hpoLabel') AS hpo_label,
    json_extract_string(value, '$.assertionContext') AS assertion_context,
    json_extract_string(value, '$.subjectContext') AS subject_context,
    json_extract_string(value, '$.subjectId') AS subject_id,
    json_extract_string(value, '$.evidenceText') AS evidence_text,
    CAST(json_extract(value, '$.startOffset') AS INTEGER) AS start_offset,
    CAST(json_extract(value, '$.endOffset') AS INTEGER) AS end_offset,
    json_extract_string(value, '$.sourceDigest') AS source_digest,
    json_extract_string(value, '$.ontologySource') AS ontology_source,
    json_extract_string(value, '$.ontologyVersion') AS ontology_version,
    json_extract_string(value, '$.ontologyDigest') AS ontology_digest,
    json_extract_string(value, '$.proposalId') AS proposal_id,
    json_extract_string(value, '$.proposalProvider') AS proposal_provider,
    json_extract_string(value, '$.proposalModel') AS proposal_model,
    CAST(json_extract(value, '$.confidence') AS DOUBLE) AS proposal_confidence,
    json_extract_string(value, '$.review.decision') AS review_decision,
    json_extract_string(value, '$.review.reviewer') AS review_reviewer,
    json_extract_string(value, '$.review.proposalDigest') AS review_proposal_digest,
    json_extract_string(value, '$.review.inputDigest') AS review_input_digest,
    json_extract_string(value, '$.acceptanceState') AS acceptance_state
  FROM json_each(getvariable('grounded_phenotypes_json'))
), ontology_identity AS (
  SELECT DISTINCT hpo_id, label, ontology_source, ontology_version, ontology_digest
  FROM hpo_terms
), checked AS (
  SELECT p.*,
    CASE
      WHEN n.case_id IS NULL THEN error('grounded phenotype references an unknown case')
      WHEN p.source_digest <> 'sha256:' || sha256(n.narrative) THEN error('grounded phenotype source digest mismatch')
      WHEN p.start_offset IS NULL OR p.end_offset IS NULL OR p.start_offset < 0 OR p.end_offset <= p.start_offset
        OR p.end_offset > length(n.narrative) THEN error('grounded phenotype has invalid source offsets')
      WHEN substr(n.narrative, p.start_offset + 1, p.end_offset - p.start_offset) <> p.evidence_text
        THEN error('grounded phenotype evidence does not match the source narrative')
      WHEN h.hpo_id IS NULL THEN error('grounded phenotype references an undeclared ontology term')
      WHEN p.hpo_label <> h.label OR p.ontology_source <> h.ontology_source
        OR p.ontology_version <> h.ontology_version OR p.ontology_digest <> h.ontology_digest
        THEN error('grounded phenotype ontology identity mismatch')
      WHEN p.assertion_context NOT IN ('present', 'absent', 'uncertain', 'differential')
        THEN error('grounded phenotype has an invalid assertion context')
      WHEN p.subject_context NOT IN ('proband', 'family')
        OR (p.subject_context = 'family' AND coalesce(p.subject_id, '') = '')
        THEN error('grounded phenotype has an invalid subject context')
      WHEN p.review_decision <> 'approved' OR p.acceptance_state <> 'accepted'
        THEN error('grounded phenotype is not approved and accepted')
      WHEN coalesce(p.proposal_id, '') = '' OR coalesce(p.review_reviewer, '') = ''
        OR coalesce(p.review_proposal_digest, '') = '' OR coalesce(p.review_input_digest, '') = ''
        THEN error('grounded phenotype is missing proposal or review identity')
      ELSE true
    END AS valid
  FROM parsed p
  LEFT JOIN case_narratives n USING (case_id)
  LEFT JOIN ontology_identity h USING (hpo_id)
)
SELECT
  case_id, hpo_id, hpo_label, assertion_context, subject_context, subject_id,
  evidence_text, start_offset, end_offset, source_digest, ontology_source,
  ontology_version, ontology_digest, proposal_id, proposal_provider, proposal_model,
  proposal_confidence, review_decision, review_reviewer, review_proposal_digest,
  review_input_digest, acceptance_state
FROM checked
WHERE valid
