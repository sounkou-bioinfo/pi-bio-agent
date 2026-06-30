// LIVE flagship driver: real WGS chr22 -> duckhts region read -> chunked VEP /region annotation (the
// src/duckdb/ncurl-fanout.ts launch->drain->retry loop) -> parse -> join ClinVar -> rare + high-impact (rhi).
// Hits Ensembl REST live. Run:  npm run build && node examples/wgs-chr22-annotation/live.mjs
// Point VCF/CLINVAR at your own bgzipped + tabix-indexed GRCh38 files (the sample VCF needs a .tbi:
//   tabix -p vcf your.vcf.gz). ducknng + duckhts must be provisioned (INSTALL ... ; the script LOADs them).
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../../dist/duckdb/node-api.js";
import { ncurlFanout } from "../../dist/duckdb/ncurl-fanout.js";

const VCF = process.env.WGS_VCF ?? "/root/WG010.vcf.gz";
const CLINVAR = process.env.CLINVAR_VCF ?? "/root/duckhts/clinvar.vcf.gz";
const REGION = process.env.WGS_REGION ?? "chr22:23000000-24000000"; // gene-rich ~1Mb
const CV_REGION = REGION.replace("chr", ""); // ClinVar contigs are '22', not 'chr22'
const CONTIG = CV_REGION.split(":")[0]; // the normalized contig (e.g. '22'), derived — NOT hard-coded
const BATCH = 200; // VEP /region POST cap
const VEP = "https://rest.ensembl.org/vep/human/region";
const HEADERS = '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]';

// NB: allow_unsigned_extensions is NOT required for the community duckhts/ducknng/nanoarrow used here — they are
// SIGNED and load without it. It is set defensively only in case a LOCAL dev build of an extension is unsigned;
// in a clean deployment you can drop it. duckdbConfig stays the right home for real settings (cache_httpfs, S3).
const conn = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
const J = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2);

await conn.run("LOAD duckhts");
await conn.run("INSTALL ducknng FROM community"); await conn.run("LOAD ducknng");
await conn.run("SET VARIABLE tls = ducknng_tls_config_from_files(NULL, '/etc/ssl/certs/ca-certificates.crt', '', 1)");

// 1. duckhts region reads (only the region's index blocks are touched, not the whole genome)
await conn.run("CREATE TABLE vcf_raw AS SELECT * FROM read_bcf(?, region := ?, tidy_format := true)", [VCF, REGION]);
await conn.run(
  "CREATE TABLE clinvar AS SELECT replace(CHROM,'chr','') AS chrom, POS, REF, ALT, CAST(INFO_CLNSIG AS VARCHAR) AS clnsig FROM read_bcf(?, region := ?, tidy_format := true)",
  [CLINVAR, CV_REGION],
);
const [{ nv }] = await conn.all("SELECT count(*) nv FROM vcf_raw");
console.log(`chr22 variants: ${Number(nv)}`);

// 2. batches: VCF-format strings (strip chr, first ALT), <=200 per POST body (NOTE: '//' = integer division)
await conn.run(`CREATE TABLE batches AS
  WITH v AS (
    SELECT (row_number() OVER (ORDER BY POS) - 1) // ${BATCH} AS batch_id,
           replace(CHROM,'chr','') || ' ' || POS || ' . ' || REF || ' ' || ALT[1] || ' . . .' AS vstr
    FROM vcf_raw WHERE ALT[1] IS NOT NULL)
  SELECT batch_id, '{"variants":' || json_group_array(vstr) || '}' AS body FROM v GROUP BY batch_id`);
const [{ nb }] = await conn.all("SELECT count(*) nb FROM batches");
console.log(`VEP batches (<=${BATCH} each): ${Number(nb)}`);

// 3. CHUNKED FANOUT: scalar ncurl_aio launch per batch + loop-drain + status-driven retry (the host-side loop).
// Resolve the TLS config id to a bound number (the driver binds it, never interpolates SQL); cap concurrency.
const [{ tls }] = await conn.all("SELECT getvariable('tls')::BIGINT AS tls");
const fan = await ncurlFanout(conn, {
  batchesTable: "batches", resultsTable: "results",
  url: VEP, headersJson: HEADERS, tlsConfigId: Number(tls), timeoutMs: 60000, maxInFlight: 6,
});
console.log(`fanout: ${J(fan)}`);

// 4. parse all returned bodies in ONE pass (combine JSON arrays -> a variable -> ducknng_parse_body -> structs)
await conn.run("SET VARIABLE anno = (SELECT '[' || string_agg(trim(body_text,'[]'), ',') || ']' FROM results WHERE length(trim(body_text,'[]')) > 0)");
await conn.run("CREATE TABLE vep AS SELECT * FROM ducknng_parse_body(getvariable('anno')::BLOB, 'application/json')");

// 5. unnest + join ClinVar -> rare + high-impact (rhi), ClinVar classification shown as an annotation
await conn.run(`CREATE TABLE joined AS
  WITH ex AS (
    SELECT split_part(v.input,' ',2)::BIGINT AS pos, split_part(v.input,' ',4) AS ref, split_part(v.input,' ',5) AS alt,
           v.most_severe_consequence AS csq, UNNEST(v.transcript_consequences) AS tc, v.colocated_variants AS cvs
    FROM vep v WHERE v.transcript_consequences IS NOT NULL)
  SELECT DISTINCT a.pos, a.ref, a.alt, a.gene, a.impact, a.csq, a.gnomadg, CAST(cv.clnsig AS VARCHAR) AS clinvar
  FROM (SELECT pos, ref, alt, csq, tc.gene_symbol AS gene, tc.impact AS impact,
               TRY_CAST(json_extract_string(to_json(cvs), '$[0].frequencies.' || alt || '.gnomadg') AS DOUBLE) AS gnomadg
        FROM ex) a
  LEFT JOIN clinvar cv ON cv.chrom = '${CONTIG}' AND cv.POS = a.pos AND cv.REF = a.ref AND list_contains(cv.ALT, a.alt)`);

console.log("funnel:", J(await conn.all(`SELECT
  count(*) annotated_gene_variants,
  count(*) FILTER (WHERE coalesce(gnomadg,0.0) < 0.01) rare,
  count(*) FILTER (WHERE impact='HIGH') high_impact,
  count(*) FILTER (WHERE clinvar IS NOT NULL) in_clinvar,
  count(*) FILTER (WHERE clinvar ILIKE '%patho%') clinvar_pathogenic FROM joined`)));

console.log("RARE + HIGH-IMPACT (LoF) hits:", J(await conn.all(`
  SELECT DISTINCT gene, pos, ref, alt, csq AS consequence, round(coalesce(gnomadg,0.0),5) AS gnomad_af,
         coalesce(clinvar, '(not in ClinVar)') AS clinvar
  FROM joined WHERE coalesce(gnomadg,0.0) < 0.01 AND impact = 'HIGH' ORDER BY gene, pos`)));
