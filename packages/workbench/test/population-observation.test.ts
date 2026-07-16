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
const presentResponsePath = join(
  fixtureRoot,
  "data",
  "conformance",
  "gnomad-v4.1.1-grch38-rs334-2026-07-14.json",
);
const absentResponsePath = join(
  fixtureRoot,
  "data",
  "conformance",
  "gnomad-v4.1.1-grch38-hbb-t-c-not-found-2026-07-14.json",
);
const presentDigest = "sha256:590a00459c3070616cf215b0aeaf68a54e05d74433212ceb57df052c3e82c6eb";
const absentDigest = "sha256:4fb38a733d7e6f1b61444803ec5f9a8266004115c963e1b80aacb4cd8df77e2e";

type JsonRow = Record<string, unknown>;

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-population-"));
  await fs.cp(fixtureRoot, dir, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  return dir;
}

function populationQuery(
  queryId: string,
  alt: string,
  sequencingType: "exome" | "genome" | "joint",
  population: string,
): JsonRow {
  const sourceVariantId = `11-5227002-T-${alt}`;
  return {
    query_id: queryId,
    scope_id: `scope:${sourceVariantId}`,
    variant_id: sourceVariantId,
    gene_id: "HGNC:4827",
    disease_id: "MONDO:0011382",
    moi: "AR",
    assembly: "GRCh38",
    chrom: "11",
    pos: 5227002,
    ref: "T",
    alt,
    source_variant_id: sourceVariantId,
    dataset_id: "gnomad_r4",
    sequencing_type: sequencingType,
    population,
  };
}

async function startRecordedResponses(present: string, absent: string): Promise<{
  url: string;
  requestBodies: string[];
  close: () => Promise<void>;
}> {
  const requestBodies: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    requestBodies.push(body);
    const variantId = String((JSON.parse(body) as { variables?: { variantId?: string } }).variables?.variantId);
    const responseBody = variantId === "11-5227002-T-A" ? present : absent;
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(responseBody),
    });
    response.end(responseBody);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("recorded gnomAD server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    requestBodies,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function runPopFrq(
  workspace: string,
  scope: JsonRow,
  populationRows: readonly JsonRow[],
  diseaseRows: readonly JsonRow[],
  runId: string,
): Promise<JsonRow> {
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_pop_frq",
    runId,
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify([scope]),
      svcv4_population_observations_json: JSON.stringify(populationRows),
      svcv4_disease_frequency_observations_json: JSON.stringify(diseaseRows),
    },
    protectedSessionVariables: [
      "svcv4_scopes_json",
      "svcv4_population_observations_json",
      "svcv4_disease_frequency_observations_json",
    ],
  });
  if (!response.ok) throw new Error(response.error);
  return response.result.rows[0] as JsonRow;
}

test("real gnomAD v4.1.1 responses preserve measured, counted-zero, filtered, and no-hit semantics", async () => {
  const workspace = await copyFixture();
  const present = await fs.readFile(presentResponsePath, "utf8");
  const absent = await fs.readFile(absentResponsePath, "utf8");
  assert.equal(`sha256:${createHash("sha256").update(present).digest("hex")}`, presentDigest);
  assert.equal(`sha256:${createHash("sha256").update(absent).digest("hex")}`, absentDigest);
  const recorded = await startRecordedResponses(present, absent);
  const queries = [
    populationQuery("rs334-exome-afr", "A", "exome", "afr"),
    populationQuery("rs334-exome-fin", "A", "exome", "fin"),
    populationQuery("rs334-joint-global", "A", "joint", "global"),
    populationQuery("hbb-t-c-exome-global", "C", "exome", "global"),
  ];
  let rows: JsonRow[];
  try {
    const manifest = JSON.parse(await fs.readFile(join(workspace, "manifest.json"), "utf8")) as BioManifest;
    const httpResource = manifest.provides?.resources?.find((resource) => resource.id === "gnomad_http_results");
    if (!httpResource) throw new Error("clinical manifest has no gnomAD HTTP resource");
    httpResource.params = {
      ...httpResource.params,
      declaredSources: ["https://gnomad.broadinstitute.org/api"],
      sourceVersion: "v4.1.1-response-observed-2026-07-14",
    };
    const response = await runBioOperationFromManifest({
      cwd: workspace,
      dbPath: ":memory:",
      manifestSnapshot: manifest,
      manifestBaseDir: workspace,
      operationId: "clinical.gnomad_population_observations",
      runId: "real-gnomad-rs334-population-normalization",
      duckdbInitSql: ["LOAD ducknng", "SET VARIABLE gnomad_tls_config_id = 0"],
      protectedSessionBindings: {
        gnomad_population_queries_json: JSON.stringify(queries),
        gnomad_url: recorded.url,
        gnomad_headers_json: '[{"name":"Content-Type","value":"application/json"}]',
        gnomad_profile_id: "",
        gnomad_source_id: "https://gnomad.broadinstitute.org/api",
        gnomad_source_version: "4.1.1",
        gnomad_source_uri: "https://gnomad.broadinstitute.org/api",
        gnomad_observed_at: "2026-07-14T00:03:32Z",
      },
      protectedSessionVariables: [
        "gnomad_population_queries_json", "gnomad_url", "gnomad_headers_json", "gnomad_profile_id",
        "gnomad_source_id", "gnomad_source_version", "gnomad_source_uri", "gnomad_observed_at",
      ],
    });
    if (!response.ok) throw new Error(response.error);
    rows = response.result.rows as JsonRow[];
  } finally {
    await recorded.close();
  }

  assert.equal(recorded.requestBodies.length, 2, "strata for one allele share one GraphQL request");
  const requestedVariants = recorded.requestBodies
    .map((body) => String((JSON.parse(body) as { variables: { variantId: string } }).variables.variantId))
    .sort();
  assert.deepEqual(requestedVariants, ["11-5227002-T-A", "11-5227002-T-C"]);
  const byQuery = new Map(rows.map((row) => [String(row.source_query_id), row]));

  const afr = byQuery.get("rs334-exome-afr")!;
  assert.deepEqual({
    state: afr.frequency_state,
    ac: afr.allele_count,
    an: afr.allele_number,
    filters: afr.source_filters,
    filterState: afr.source_filter_state,
    digest: afr.source_digest,
    admission: afr.admission_state,
  }, {
    state: "measured",
    ac: 1897,
    an: 33354,
    filters: [],
    filterState: "passed",
    digest: presentDigest,
    admission: "proposed",
  });
  assert.ok(Math.abs(Number(afr.allele_frequency) - (1897 / 33354)) < 1e-15);

  const fin = byQuery.get("rs334-exome-fin")!;
  assert.deepEqual(
    [fin.frequency_state, fin.allele_frequency, fin.allele_count, fin.allele_number],
    ["counted_zero", 0, 0, 53408],
  );

  const joint = byQuery.get("rs334-joint-global")!;
  assert.equal(joint.frequency_state, "measured");
  assert.equal(joint.source_filter_state, "failed");
  assert.deepEqual(joint.source_filters, ["discrepant_frequencies"]);

  const noHit = byQuery.get("hbb-t-c-exome-global")!;
  assert.deepEqual({
    state: noHit.frequency_state,
    query: noHit.query_state,
    coverage: noHit.coverage_state,
    af: noHit.allele_frequency,
    ac: noHit.allele_count,
    an: noHit.allele_number,
    callableAn: noHit.callable_allele_number,
    errors: noHit.source_error_codes,
    digest: noHit.source_digest,
  }, {
    state: "not_observed",
    query: "completed",
    coverage: "unknown",
    af: null,
    ac: null,
    an: null,
    callableAn: null,
    errors: ["variant_not_found"],
    digest: absentDigest,
  });

  const scope = {
    scope_id: "scope:11-5227002-T-A",
    variant_id: "11-5227002-T-A",
    gene_id: "HGNC:4827",
    disease_id: "MONDO:0011382",
    moi: "AR",
    evaluation_mode: "case_independent",
    allow_provisional: true,
    expected_method_codes: ["POP_FRQ"],
  };
  const missingDiseaseFrequency = await runPopFrq(
    workspace,
    scope,
    [{ ...afr, admission_state: "accepted" }],
    [],
    "real-rs334-pop-frq-without-disease-frequency",
  );
  assert.equal(missingDiseaseFrequency.reason_code, "disease_frequency_evidence_missing");

  const conformanceDiseaseFrequency = {
    item_id: "conformance-only-disease-frequency",
    ...scope,
    admission_state: "accepted",
    frequency_measure: "maximum_credible_population_allele_frequency",
    disease_max_credible_frequency: 0.001,
    derivation_method: "conformance-only-not-clinical",
    derivation_version: "1",
    derivation_digest: `sha256:${"c".repeat(64)}`,
    source_id: "conformance-test",
    source_version: "1",
    source_uri: "urn:pi-bio:conformance-only",
    source_digest: `sha256:${"d".repeat(64)}`,
    observed_at: "2026-07-14T00:03:32Z",
  };
  delete (conformanceDiseaseFrequency as JsonRow).evaluation_mode;
  delete (conformanceDiseaseFrequency as JsonRow).allow_provisional;
  delete (conformanceDiseaseFrequency as JsonRow).expected_method_codes;
  const filteredJoint = await runPopFrq(
    workspace,
    scope,
    [{ ...joint, admission_state: "accepted" }],
    [conformanceDiseaseFrequency],
    "real-rs334-filtered-joint-pop-frq",
  );
  assert.deepEqual(filteredJoint.observation_errors, ["population_source_not_filter_passed"]);
  assert.equal(filteredJoint.evaluation_state, "not_evaluated");
});
