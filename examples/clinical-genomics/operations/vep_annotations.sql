WITH exploded AS (
  SELECT
    replace(split_part(v.input, ' ', 1), 'chr', '') || '-' || split_part(v.input, ' ', 2) || '-' || split_part(v.input, ' ', 4) || '-' || split_part(v.input, ' ', 5) AS variant_key,
    v.input,
    v.most_severe_consequence,
    json_extract_string(tc.value, '$.gene_symbol') AS gene,
    json_extract_string(tc.value, '$.impact') AS impact,
    coalesce(json_extract_string(tc.value, '$.consequence_terms[0]'), v.most_severe_consequence) AS consequence,
    v.colocated_variants AS colocated_variants,
    split_part(v.input, ' ', 5) AS alt
  FROM vep_response v
  CROSS JOIN json_each(v.transcript_consequences) AS tc
  WHERE v.input IS NOT NULL
), transcript_rows AS (
  SELECT
    variant_key,
    input,
    gene,
    impact,
    consequence,
    try_cast(json_extract_string(colocated_variants, '$[0].frequencies.' || alt || '.gnomadg') AS DOUBLE) AS allele_frequency,
    json_extract_string(colocated_variants, '$[0].clin_sig[0]') AS clinical_significance,
    most_severe_consequence
  FROM exploded
)
SELECT
  variant_key,
  input,
  gene,
  impact,
  consequence,
  allele_frequency,
  clinical_significance,
  most_severe_consequence,
  'vep' AS annotation_source
FROM transcript_rows
ORDER BY variant_key, gene, impact DESC, consequence;
