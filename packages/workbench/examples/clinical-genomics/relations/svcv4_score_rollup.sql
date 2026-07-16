-- Roll-up is a fixed-depth execution of the configured score tree. Every node,
-- parent edge, cap, and method scope lives in svcv4_score_nodes; the SQL supplies
-- only the generic reduction mechanics.
WITH eligible AS (
  SELECT *
  FROM svcv4_line_audit
  WHERE audit_status = 'complete'
    AND evaluation_state IN ('scored', 'no_evidence')
), branch_totals AS (
  -- Protein and splice alternatives are compared on uncapped raw totals. Only
  -- the more pathogenic branch continues; branch scores are never added.
  SELECT
    scope_id,
    branch_group,
    branch_id,
    sum(effective_score) AS branch_raw_score
  FROM eligible
  WHERE branch_group IS NOT NULL
  GROUP BY scope_id, branch_group, branch_id
), branch_ranking AS (
  SELECT
    *,
    row_number() OVER (
      PARTITION BY scope_id, branch_group
      ORDER BY branch_raw_score DESC, branch_id
    ) AS branch_rank
  FROM branch_totals
), selected_lines AS (
  SELECT e.*
  FROM eligible e
  LEFT JOIN branch_ranking b
    ON b.scope_id = e.scope_id
   AND b.branch_group = e.branch_group
   AND b.branch_id = e.branch_id
  WHERE e.branch_group IS NULL OR b.branch_rank = 1
), leaf_raw AS (
  SELECT
    scope_id,
    profile_id,
    profile_version,
    method_code AS node_code,
    parent_node_code,
    0::INTEGER AS node_stage,
    'method' AS node_kind,
    min(method_min_score) AS min_score,
    min(method_max_score) AS max_score,
    sum(effective_score) AS raw_score,
    min(branch_group) AS branch_group,
    min(branch_id) AS branch_id
  FROM selected_lines
  GROUP BY scope_id, profile_id, profile_version, method_code, parent_node_code
), leaf AS (
  -- Caps apply after branch selection, first at method nodes and then at each
  -- configured parent stage. raw_score remains visible for review.
  SELECT
    *,
    CASE
      WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score
      WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score
      ELSE raw_score
    END AS capped_score
  FROM leaf_raw
), stage1_raw AS (
  -- The public draft hierarchy has bounded depth. Explicit stages avoid a
  -- recursive engine dependency while preserving data-driven parentage/caps.
  SELECT
    c.scope_id,
    c.profile_id,
    c.profile_version,
    n.node_code,
    n.parent_node_code,
    1::INTEGER AS node_stage,
    n.node_kind,
    try_cast(n.min_score AS DOUBLE) AS min_score,
    try_cast(n.max_score AS DOUBLE) AS max_score,
    sum(c.capped_score) AS raw_score
  FROM leaf c
  JOIN svcv4_score_nodes n
    ON n.profile_id = c.profile_id AND n.profile_version = c.profile_version
   AND n.node_stage = 1 AND n.node_code = c.parent_node_code
  GROUP BY c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, n.node_kind, n.min_score, n.max_score
), stage1 AS (
  SELECT *, CASE WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score ELSE raw_score END AS capped_score
  FROM stage1_raw
), stage2_raw AS (
  SELECT c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, 2::INTEGER AS node_stage, n.node_kind,
    try_cast(n.min_score AS DOUBLE) AS min_score, try_cast(n.max_score AS DOUBLE) AS max_score, sum(c.capped_score) AS raw_score
  FROM stage1 c JOIN svcv4_score_nodes n
    ON n.profile_id = c.profile_id AND n.profile_version = c.profile_version AND n.node_stage = 2 AND n.node_code = c.parent_node_code
  GROUP BY c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, n.node_kind, n.min_score, n.max_score
), stage2 AS (
  SELECT *, CASE WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score ELSE raw_score END AS capped_score
  FROM stage2_raw
), stage3_raw AS (
  SELECT c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, 3::INTEGER AS node_stage, n.node_kind,
    try_cast(n.min_score AS DOUBLE) AS min_score, try_cast(n.max_score AS DOUBLE) AS max_score, sum(c.capped_score) AS raw_score
  FROM stage2 c JOIN svcv4_score_nodes n
    ON n.profile_id = c.profile_id AND n.profile_version = c.profile_version AND n.node_stage = 3 AND n.node_code = c.parent_node_code
  GROUP BY c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, n.node_kind, n.min_score, n.max_score
), stage3 AS (
  SELECT *, CASE WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score ELSE raw_score END AS capped_score
  FROM stage3_raw
), stage4_raw AS (
  SELECT c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, 4::INTEGER AS node_stage, n.node_kind,
    try_cast(n.min_score AS DOUBLE) AS min_score, try_cast(n.max_score AS DOUBLE) AS max_score, sum(c.capped_score) AS raw_score
  FROM stage3 c JOIN svcv4_score_nodes n
    ON n.profile_id = c.profile_id AND n.profile_version = c.profile_version AND n.node_stage = 4 AND n.node_code = c.parent_node_code
  GROUP BY c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, n.node_kind, n.min_score, n.max_score
), stage4 AS (
  SELECT *, CASE WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score ELSE raw_score END AS capped_score
  FROM stage4_raw
), stage5_raw AS (
  SELECT c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, 5::INTEGER AS node_stage, n.node_kind,
    try_cast(n.min_score AS DOUBLE) AS min_score, try_cast(n.max_score AS DOUBLE) AS max_score, sum(c.capped_score) AS raw_score
  FROM stage4 c JOIN svcv4_score_nodes n
    ON n.profile_id = c.profile_id AND n.profile_version = c.profile_version AND n.node_stage = 5 AND n.node_code = c.parent_node_code
  GROUP BY c.scope_id, c.profile_id, c.profile_version, n.node_code, n.parent_node_code, n.node_kind, n.min_score, n.max_score
), stage5 AS (
  SELECT *, CASE WHEN min_score IS NOT NULL AND raw_score < min_score THEN min_score WHEN max_score IS NOT NULL AND raw_score > max_score THEN max_score ELSE raw_score END AS capped_score
  FROM stage5_raw
)
SELECT *, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM leaf
UNION ALL BY NAME
SELECT *, NULL::VARCHAR AS branch_group, NULL::VARCHAR AS branch_id, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM stage1
UNION ALL BY NAME
SELECT *, NULL::VARCHAR AS branch_group, NULL::VARCHAR AS branch_id, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM stage2
UNION ALL BY NAME
SELECT *, NULL::VARCHAR AS branch_group, NULL::VARCHAR AS branch_id, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM stage3
UNION ALL BY NAME
SELECT *, NULL::VARCHAR AS branch_group, NULL::VARCHAR AS branch_id, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM stage4
UNION ALL BY NAME
SELECT *, NULL::VARCHAR AS branch_group, NULL::VARCHAR AS branch_id, raw_score IS DISTINCT FROM capped_score AS cap_applied FROM stage5
