-- GraphQL transport is generic DuckNNG fanout. One request retrieves the three
-- frequency containers needed by any registered stratum for this variant.
WITH requested AS (
  SELECT DISTINCT
    json_extract_string(value, '$.source_variant_id') AS source_variant_id,
    json_extract_string(value, '$.dataset_id') AS dataset_id
  FROM json_each(CAST(getvariable('gnomad_population_queries_json') AS JSON))
  WHERE coalesce(json_extract_string(value, '$.source_variant_id'), '') <> ''
    AND json_extract_string(value, '$.dataset_id') IN ('gnomad_r4', 'gnomad_r4_non_ukb')
), batched AS (
  SELECT
    dense_rank() OVER (ORDER BY dataset_id, source_variant_id) - 1 AS batch_id,
    source_variant_id,
    dataset_id
  FROM requested
)
SELECT
  batch_id,
  json_object(
    'query', 'query PopulationVariant($variantId: String!, $datasetId: DatasetId!) { variant(variantId: $variantId, dataset: $datasetId) { variant_id reference_genome chrom pos ref alt rsids exome { ac an filters populations { id ac an homozygote_count hemizygote_count } } genome { ac an filters populations { id ac an homozygote_count hemizygote_count } } joint { ac an filters populations { id ac an homozygote_count hemizygote_count } } } }',
    'variables', json_object('variantId', source_variant_id, 'datasetId', dataset_id)
  )::VARCHAR AS body
FROM batched
ORDER BY batch_id
