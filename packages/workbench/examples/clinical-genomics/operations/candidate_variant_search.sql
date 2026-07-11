WITH interval_rows AS (
  SELECT
    json_extract_string(value, '$.gene_id') AS gene_id,
    json_extract_string(value, '$.gene') AS gene,
    json_extract_string(value, '$.disease_id') AS disease_id,
    try_cast(json_extract(value, '$.hypothesis_rank') AS INTEGER) AS hypothesis_rank,
    json_extract_string(value, '$.assembly') AS assembly,
    json_extract_string(value, '$.chrom') AS chrom,
    try_cast(json_extract(value, '$.start_1based') AS BIGINT) AS start_1based,
    try_cast(json_extract(value, '$.end_1based') AS BIGINT) AS end_1based,
    json_extract_string(value, '$.interval_status') AS interval_status
  FROM json_each(CAST(getvariable('intervals_json') AS JSON))
), resolved AS (
  SELECT *
  FROM interval_rows
  WHERE interval_status = 'resolved'
), validation AS (
  SELECT CASE
    WHEN count(*) FILTER (WHERE c.chrom IS NULL) > 0 THEN error(
      'candidate variant search requested absent VCF contig ' || min(r.chrom) FILTER (WHERE c.chrom IS NULL)
    )
    WHEN count(*) FILTER (
      WHERE c.assembly IS NOT NULL AND lower(c.assembly) <> lower(r.assembly)
    ) > 0 THEN error(
      'candidate variant search assembly mismatch on contig ' || min(r.chrom) FILTER (
        WHERE c.assembly IS NOT NULL AND lower(c.assembly) <> lower(r.assembly)
      )
    )
    ELSE true
  END AS valid
  FROM resolved r
  LEFT JOIN case_vcf_contigs c USING (chrom)
), alleles AS (
  SELECT
    raw.CHROM AS chrom,
    raw.POS AS pos,
    raw.REF AS ref,
    allele.alt,
    allele.alt_index,
    list_extract(raw.INFO_GENE, allele.alt_index) AS annotated_gene,
    list_extract(raw.INFO_CSQ, allele.alt_index) AS consequence,
    try_cast(list_extract(raw.INFO_AF, allele.alt_index) AS DOUBLE) AS allele_frequency,
    replace(list_extract(raw.INFO_CLNSIG, allele.alt_index), '_', ' ') AS clinical_significance,
    list_extract(raw.INFO_ZYGOSITY, allele.alt_index) AS zygosity,
    list_extract(raw.INFO_INHERITANCE, allele.alt_index) AS inheritance
  FROM case_vcf_raw raw
  CROSS JOIN UNNEST(raw.ALT) WITH ORDINALITY AS allele(alt, alt_index)
), selected AS (
  SELECT
    i.gene_id,
    i.gene,
    i.disease_id,
    i.hypothesis_rank,
    i.assembly,
    i.chrom,
    i.start_1based,
    i.end_1based,
    a.pos,
    a.ref,
    a.alt,
    a.annotated_gene,
    a.consequence,
    a.allele_frequency,
    a.clinical_significance,
    a.zygosity,
    a.inheritance,
    a.chrom || '-' || a.pos || '-' || a.ref || '-' || a.alt AS variant_key
  FROM resolved i
  JOIN alleles a
    ON i.chrom = a.chrom
   AND a.pos BETWEEN i.start_1based AND i.end_1based
), variant_rows AS (
  SELECT
    gene_id,
    gene,
    MIN(hypothesis_rank)::INTEGER AS hypothesis_rank,
    any_value(assembly) AS assembly,
    any_value(chrom) AS chrom,
    MIN(start_1based) AS start_1based,
    MAX(end_1based) AS end_1based,
    list_sort(list_distinct(list(disease_id))) AS disease_ids,
    variant_key,
    any_value(pos) AS pos,
    any_value(ref) AS ref,
    any_value(alt) AS alt,
    CASE
      WHEN count(DISTINCT struct_pack(
        annotated_gene := annotated_gene,
        consequence := consequence,
        allele_frequency := allele_frequency,
        clinical_significance := clinical_significance,
        zygosity := zygosity,
        inheritance := inheritance
      )) > 1 THEN error('conflicting duplicate annotations for allele ' || variant_key)
      ELSE any_value(annotated_gene)
    END AS annotated_gene,
    any_value(consequence) AS consequence,
    any_value(allele_frequency) AS allele_frequency,
    any_value(clinical_significance) AS clinical_significance,
    any_value(zygosity) AS zygosity,
    any_value(inheritance) AS inheritance
  FROM selected
  GROUP BY gene_id, gene, variant_key
), coverage_rows AS (
  SELECT
    i.gene_id,
    i.gene,
    MIN(i.hypothesis_rank)::INTEGER AS hypothesis_rank,
    any_value(i.assembly) AS assembly,
    any_value(i.chrom) AS chrom,
    MIN(i.start_1based) AS start_1based,
    MAX(i.end_1based) AS end_1based,
    list_sort(list_distinct(list(i.disease_id))) AS disease_ids,
    CASE
      WHEN bool_and(i.interval_status = 'resolved') THEN 'completed'
      WHEN bool_or(i.interval_status = 'ambiguous_locus') THEN 'ambiguous_locus'
      ELSE 'missing_gene_interval'
    END AS search_status,
    CASE
      WHEN bool_and(i.interval_status = 'resolved')
      THEN any_value(i.chrom) || ':' || MIN(i.start_1based) || '-' || MAX(i.end_1based)
      ELSE NULL
    END AS search_scope,
    COUNT(DISTINCT v.variant_key)::INTEGER AS searched_variant_count
  FROM interval_rows i
  CROSS JOIN validation checked
  LEFT JOIN variant_rows v
    ON v.gene_id = i.gene_id
  WHERE checked.valid
  GROUP BY i.gene_id, i.gene
)
SELECT
  'coverage' AS record_kind,
  getvariable('case_id')::VARCHAR AS case_id,
  c.gene_id,
  c.gene,
  c.disease_ids,
  c.hypothesis_rank,
  c.assembly,
  c.chrom,
  c.start_1based,
  c.end_1based,
  c.search_status,
  c.search_scope,
  c.searched_variant_count,
  NULL::VARCHAR AS variant_key,
  NULL::BIGINT AS pos,
  NULL::VARCHAR AS ref,
  NULL::VARCHAR AS alt,
  NULL::VARCHAR AS annotated_gene,
  NULL::VARCHAR AS consequence,
  NULL::DOUBLE AS allele_frequency,
  NULL::VARCHAR AS clinical_significance,
  NULL::VARCHAR AS zygosity,
  NULL::VARCHAR AS inheritance
FROM coverage_rows c
UNION ALL
SELECT
  'variant' AS record_kind,
  getvariable('case_id')::VARCHAR AS case_id,
  v.gene_id,
  v.gene,
  v.disease_ids,
  v.hypothesis_rank,
  v.assembly,
  v.chrom,
  v.start_1based,
  v.end_1based,
  'completed' AS search_status,
  v.chrom || ':' || v.start_1based || '-' || v.end_1based AS search_scope,
  c.searched_variant_count,
  v.variant_key,
  v.pos,
  v.ref,
  v.alt,
  v.annotated_gene,
  v.consequence,
  v.allele_frequency,
  v.clinical_significance,
  v.zygosity,
  v.inheritance
FROM variant_rows v
JOIN coverage_rows c USING (gene_id, gene)
ORDER BY record_kind, hypothesis_rank, gene, variant_key
