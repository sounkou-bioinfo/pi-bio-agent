WITH hypotheses AS (
  SELECT
    json_extract_string(value, '$.gene_id') AS gene_id,
    json_extract_string(value, '$.gene') AS gene,
    json_extract_string(value, '$.disease_id') AS disease_id,
    try_cast(json_extract(value, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank
  FROM json_each(CAST(getvariable('hypotheses_json') AS JSON))
), matching_assembly AS (
  SELECT
    h.gene_id,
    h.gene,
    h.disease_id,
    h.hypothesis_rank,
    COUNT(DISTINCT i.chrom)::INTEGER AS chromosome_count,
    any_value(i.chrom) AS chrom,
    MIN(try_cast(i.start_1based AS BIGINT)) AS start_1based,
    MAX(try_cast(i.end_1based AS BIGINT)) AS end_1based,
    list_sort(list_distinct(list(i.interval_source))) AS interval_sources,
    list_sort(list_distinct(list(i.interval_version))) AS interval_versions
  FROM hypotheses h
  JOIN gene_intervals i
    ON i.gene_id = h.gene_id
   AND i.assembly = getvariable('assembly')
  GROUP BY h.gene_id, h.gene, h.disease_id, h.hypothesis_rank
), known_gene AS (
  SELECT DISTINCT gene_id
  FROM gene_intervals
)
SELECT
  getvariable('case_id')::VARCHAR AS case_id,
  h.gene_id,
  h.gene,
  h.disease_id,
  h.hypothesis_rank,
  getvariable('assembly')::VARCHAR AS assembly,
  cast(m.chrom AS VARCHAR) AS chrom,
  m.start_1based,
  m.end_1based,
  m.interval_sources,
  m.interval_versions,
  CASE
    WHEN m.chromosome_count = 1 AND m.start_1based IS NOT NULL AND m.end_1based >= m.start_1based THEN 'resolved'
    WHEN m.chromosome_count > 1 THEN 'ambiguous_locus'
    WHEN known.gene_id IS NOT NULL THEN error(
      'candidate gene interval assembly mismatch for ' || h.gene_id || ': no interval on ' || getvariable('assembly')
    )
    ELSE 'missing_gene_interval'
  END AS interval_status
FROM hypotheses h
LEFT JOIN matching_assembly m USING (gene_id, gene, disease_id, hypothesis_rank)
LEFT JOIN known_gene known USING (gene_id)
ORDER BY h.hypothesis_rank, h.gene, h.disease_id
