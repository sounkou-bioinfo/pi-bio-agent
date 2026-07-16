import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runBioOperationFromManifest, type BioManifest } from "pi-bio-agent";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = (() => {
  const found = [
    resolve(testDir, "..", "examples", "clinical-genomics"),
    resolve(testDir, "..", "..", "examples", "clinical-genomics"),
  ].find(existsSync);
  if (!found) throw new Error(`clinical-genomics fixture not found from ${testDir}`);
  return found;
})();
const realVepResponsePath = join(
  fixtureRoot,
  "data",
  "conformance",
  "ensembl-vep-grch38-rs334-2026-07-13.json",
);
const realResponseDigest = `sha256:${"33a0aba7f1daf816cf5afcf9259ae02b2619aae0d70c5803c883d60cbe0a09b1"}`;

type JsonRow = Record<string, unknown>;

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-annotation-"));
  await fs.cp(fixtureRoot, dir, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  return dir;
}

function registeredVariant(variantKey: string, overrides: JsonRow = {}): JsonRow {
  const [chrom, pos, ref, alt] = variantKey.split("-");
  return {
    case_id: "CASE:ANNOTATION",
    variant_id: `local:${variantKey}`,
    variant_key: variantKey,
    assembly: "GRCh38",
    chrom,
    pos: Number(pos),
    ref,
    alt,
    ...overrides,
  };
}

function sourceFields(digest = `sha256:${"a".repeat(64)}`): JsonRow {
  return {
    source_id: "annotation-test-source",
    source_version: "snapshot-1",
    source_uri: "file:annotation-test.json",
    source_digest: digest,
    observed_at: "2026-07-14T00:00:00Z",
    admission_state: "accepted",
  };
}

function coverage(variant: JsonRow, transcriptCount: number | null, overrides: JsonRow = {}): JsonRow {
  return {
    record_kind: "coverage",
    annotation_state: transcriptCount == null ? "response_missing" : "completed",
    item_id: `coverage:${String(variant.variant_key)}`,
    ...variant,
    source_variant_key: variant.variant_key,
    transcript_count: transcriptCount,
    ...sourceFields(),
    ...overrides,
  };
}

function transcript(variant: JsonRow, overrides: JsonRow = {}): JsonRow {
  return {
    record_kind: "transcript_consequence",
    annotation_state: "observed",
    item_id: `transcript:${String(variant.variant_key)}`,
    ...variant,
    source_variant_key: variant.variant_key,
    transcript_count: 1,
    gene_id: "ENSG00000244734",
    gene: "HBB",
    transcript_id: "ENST00000335295",
    transcript_biotype: "protein_coding",
    is_canonical: true,
    mane_select: "NM_000518.5",
    consequence_terms: ["missense_variant"],
    most_severe_consequence: "missense_variant",
    impact: "MODERATE",
    hgvsc: "ENST00000335295.4:c.20A>T",
    hgvsp: "ENSP00000333994.3:p.Glu7Val",
    ...sourceFields(),
    ...overrides,
  };
}

async function runAudit(
  workspace: string,
  variants: readonly JsonRow[],
  observations: readonly JsonRow[],
  runId: string,
): Promise<JsonRow[]> {
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "manifest.json",
    operationId: "clinical.variant_annotation_audit",
    runId,
    protectedSessionBindings: {
      registered_annotation_variants_json: JSON.stringify(variants),
      variant_annotation_observations_json: JSON.stringify(observations),
    },
    protectedSessionVariables: [
      "registered_annotation_variants_json",
      "variant_annotation_observations_json",
    ],
  });
  if (!response.ok) throw new Error(response.error);
  return response.result.rows as JsonRow[];
}

async function startRecordedResponse(body: string): Promise<{
  url: string;
  requestBodies: string[];
  close: () => Promise<void>;
}> {
  const requestBodies: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    requestBodies.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("recorded VEP response server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/vep`,
    requestBodies,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

test("real HBB rs334 VEP response normalizes and admits identically through REST and offline snapshots", async () => {
  const workspace = await copyFixture();
  const rawResponse = await fs.readFile(realVepResponsePath, "utf8");
  assert.equal(`sha256:${createHash("sha256").update(rawResponse).digest("hex")}`, realResponseDigest);
  const recorded = await startRecordedResponse(rawResponse);
  const variant = registeredVariant("11-5227002-T-A");
  let annotationRows: JsonRow[];
  try {
    const manifest = JSON.parse(await fs.readFile(join(workspace, "manifest.json"), "utf8")) as BioManifest;
    const httpResource = manifest.provides?.resources?.find((resource) => resource.id === "vep_http_results");
    if (!httpResource) throw new Error("clinical manifest has no VEP HTTP resource");
    httpResource.params = {
      ...httpResource.params,
      declaredSources: ["https://rest.ensembl.org/vep/human/region"],
      sourceVersion: "response-observed-2026-07-13",
    };
    const response = await runBioOperationFromManifest({
      cwd: workspace,
      dbPath: ":memory:",
      manifestSnapshot: manifest,
      manifestBaseDir: workspace,
      operationId: "clinical.vep_annotations",
      runId: "real-rs334-rest-normalization",
      duckdbInitSql: ["LOAD ducknng", "SET VARIABLE vep_tls_config_id = 0"],
      protectedSessionBindings: {
        selected_variants_json: JSON.stringify([variant]),
        vep_url: recorded.url,
        vep_headers_json: '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]',
        vep_profile_id: "",
        vep_source_id: "https://rest.ensembl.org/vep/human/region",
        vep_source_version: "response-observed-2026-07-13",
        vep_source_uri: "https://rest.ensembl.org/vep/human/region?pick=1&mane=1&canonical=1&hgvs=1",
        vep_observed_at: "2026-07-13T23:34:04Z",
      },
      protectedSessionVariables: [
        "selected_variants_json", "vep_url", "vep_headers_json", "vep_profile_id",
        "vep_source_id", "vep_source_version", "vep_source_uri", "vep_observed_at",
      ],
    });
    if (!response.ok) throw new Error(response.error);
    annotationRows = response.result.rows as JsonRow[];
  } finally {
    await recorded.close();
  }

  assert.equal(recorded.requestBodies.length, 1);
  assert.deepEqual(JSON.parse(recorded.requestBodies[0]!), { variants: ["11 5227002 . T A . . ."] });
  assert.equal(annotationRows.length, 2);
  assert.ok(annotationRows.every((row) => row.source_digest === realResponseDigest));
  const restAudit = await runAudit(workspace, [variant], annotationRows, "real-rs334-rest-audit");
  assert.ok(restAudit.every((row) => row.audit_status === "complete"), JSON.stringify(restAudit, null, 2));
  const admitted = restAudit.find((row) => row.evidence_eligible === true);
  assert.deepEqual(admitted && {
    variant_key: admitted.variant_key,
    gene_id: admitted.gene_id,
    gene: admitted.gene,
    transcript_id: admitted.transcript_id,
    mane_select: admitted.mane_select,
    consequence_terms: admitted.consequence_terms,
    impact: admitted.impact,
    hgvsc: admitted.hgvsc,
    hgvsp: admitted.hgvsp,
  }, {
    variant_key: "11-5227002-T-A",
    gene_id: "ENSG00000244734",
    gene: "HBB",
    transcript_id: "ENST00000335295",
    mane_select: "NM_000518.5",
    consequence_terms: ["missense_variant"],
    impact: "MODERATE",
    hgvsc: "ENST00000335295.4:c.20A>T",
    hgvsp: "ENSP00000333994.3:p.Glu7Val",
  });
  assert.equal("allele_frequency" in admitted!, false);
  assert.equal("clinical_significance" in admitted!, false);

  const offlineRows = annotationRows.map((row) => ({
    ...row,
    source_id: "ensembl-vep-offline",
    source_version: "offline-snapshot-1",
    source_uri: "file:offline-vep-rs334.json",
    source_digest: `sha256:${"b".repeat(64)}`,
  }));
  const offlineAudit = await runAudit(workspace, [variant], offlineRows, "real-rs334-offline-audit");
  assert.ok(offlineAudit.every((row) => row.audit_status === "complete"));
  assert.deepEqual(
    offlineAudit.filter((row) => row.evidence_eligible).map((row) => [row.variant_key, row.transcript_id, row.consequence_terms]),
    restAudit.filter((row) => row.evidence_eligible).map((row) => [row.variant_key, row.transcript_id, row.consequence_terms]),
  );
});

test("annotation audit distinguishes missing responses, valid zero-transcript coverage, and invalid evidence", async () => {
  const workspace = await copyFixture();
  const missing = registeredVariant("1-100-A-G");
  const zeroTranscript = registeredVariant("1-200-C-T");
  const invalid = registeredVariant("1-300-G-A");
  const invalidDuplicate = { ...invalid };
  const observations = [
    coverage(missing, null, { source_digest: null }),
    coverage(zeroTranscript, 0),
    coverage(invalid, 1),
    transcript(invalid, {
      item_id: `coverage:${String(invalid.variant_key)}`,
      alt: "T",
      source_digest: `sha256:${"d".repeat(64)}`,
      transcript_count: 2,
      allele_frequency: 0,
    }),
  ];
  const rows = await runAudit(
    workspace,
    [missing, zeroTranscript, invalid, invalidDuplicate],
    observations,
    "annotation-audit-edge-states",
  );
  const byVariant = (variantKey: string) => rows.filter((row) => row.variant_key === variantKey);

  assert.ok(byVariant("1-100-A-G").every((row) => row.audit_status === "incomplete"));
  assert.ok((byVariant("1-100-A-G")[0]?.audit_issues as string[]).includes("incomplete:provider_response_missing"));
  assert.ok(byVariant("1-200-C-T").every((row) => row.audit_status === "complete"));
  assert.equal(byVariant("1-200-C-T").some((row) => row.evidence_eligible), false);

  assert.ok(byVariant("1-300-G-A").every((row) => row.audit_status === "invalid"));
  const issues = byVariant("1-300-G-A")[0]?.audit_issues as string[];
  assert.ok(issues.includes("invalid:duplicate_variant_registration"));
  assert.ok(issues.includes("invalid:duplicate_item_id"));
  assert.ok(issues.includes("invalid:unknown_observation_fields"));
  assert.ok(issues.includes("invalid:alt_mismatch"));
  assert.ok(issues.includes("invalid:mixed_source_snapshots"));
  assert.ok(issues.includes("invalid:row_transcript_count_mismatch"));
  assert.equal(byVariant("1-300-G-A").some((row) => row.evidence_eligible), false);
});
