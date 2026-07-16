import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fsCasStore, runBioOperationFromManifest } from "pi-bio-agent";

const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = (() => {
  const found = [
    resolve(testDir, "..", "examples", "clinical-genomics"),
    resolve(testDir, "..", "..", "examples", "clinical-genomics"),
  ].find(existsSync);
  if (!found) throw new Error(`clinical-genomics fixture not found from ${testDir}`);
  return found;
})();

async function copyFixture(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-svcv4-"));
  await fs.cp(fixtureRoot, dir, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  return dir;
}

function scope(scopeId: string) {
  return {
    scope_id: scopeId,
    variant_id: `ga4gh:VA.${scopeId}`,
    gene_id: "HGNC:TEST",
    disease_id: "MONDO:TEST",
    moi: "AD",
    evaluation_mode: "case_independent",
    allow_provisional: true,
    expected_method_codes: ["POP_FRQ"],
  };
}

function populationSource(requestedScope: ReturnType<typeof scope>, itemId: string) {
  return {
    item_id: itemId,
    scope_id: requestedScope.scope_id,
    variant_id: requestedScope.variant_id,
    gene_id: "HGNC:TEST",
    disease_id: "MONDO:TEST",
    moi: "AD",
    admission_state: "accepted",
    query_state: "completed",
    coverage_state: "adequate",
    source_filter_state: "passed",
    source_filters: [],
    population: "global",
    source_id: "population-test-source",
    source_version: "1",
    source_uri: "https://example.test/population",
    source_digest: `sha256:${"a".repeat(64)}`,
    observed_at: "2026-07-13T00:00:00Z",
  };
}

function diseaseFrequencySource(
  requestedScope: Record<string, unknown>,
  itemId = `disease-frequency:${String(requestedScope.scope_id)}`,
) {
  return {
    item_id: itemId,
    scope_id: requestedScope.scope_id,
    variant_id: requestedScope.variant_id,
    gene_id: requestedScope.gene_id,
    disease_id: requestedScope.disease_id,
    moi: requestedScope.moi,
    admission_state: "accepted",
    frequency_measure: "maximum_credible_population_allele_frequency",
    disease_max_credible_frequency: 0.001,
    derivation_method: "reviewed-disease-frequency-method",
    derivation_version: "1",
    derivation_digest: `sha256:${"d".repeat(64)}`,
    source_id: "disease-frequency-test-source",
    source_version: "1",
    source_uri: "https://example.test/disease-frequency",
    source_digest: `sha256:${"e".repeat(64)}`,
    observed_at: "2026-07-13T00:00:00Z",
  };
}

async function runPop(
  workspace: string,
  scopes: readonly Record<string, unknown>[],
  observations: readonly Record<string, unknown>[],
  runId: string,
  diseaseFrequencyObservations: readonly Record<string, unknown>[] = scopes.map((requestedScope) =>
    diseaseFrequencySource(requestedScope)
  ),
) {
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_pop_frq",
    runId,
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify(scopes),
      svcv4_population_observations_json: JSON.stringify(observations),
      svcv4_disease_frequency_observations_json: JSON.stringify(diseaseFrequencyObservations),
    },
    protectedSessionVariables: [
      "svcv4_scopes_json",
      "svcv4_population_observations_json",
      "svcv4_disease_frequency_observations_json",
    ],
  });
  if (!response.ok) throw new Error(response.error);
  assert.equal(response.ok, true);
  return response;
}

function caseScope(scopeId: string, workflow: string, moi = "AD") {
  const methodCode = workflow === "CLN_ALTV" || workflow === "CLN_ALTG" ? "CLN_ALT" : workflow;
  return {
    scope_id: scopeId,
    variant_id: `ga4gh:VA.${scopeId}`,
    gene_id: "HGNC:TEST",
    disease_id: "MONDO:TEST",
    moi,
    case_id: `CASE:${scopeId}`,
    evaluation_mode: "case_conditioned",
    allow_provisional: true,
    expected_method_codes: [methodCode],
  };
}

function caseEnvelope(
  requestedScope: ReturnType<typeof caseScope>,
  workflow: string,
  casePayload: Record<string, unknown> | null,
  itemId = `case-item:${requestedScope.scope_id}`,
) {
  return {
    item_id: itemId,
    scope_id: requestedScope.scope_id,
    case_id: requestedScope.case_id,
    workflow,
    admission_state: "accepted",
    case: casePayload,
    source_id: "case-test-source",
    source_version: "1",
    source_uri: "https://example.test/cases/1",
    source_digest: `sha256:${"c".repeat(64)}`,
    observed_at: "2026-07-14T00:00:00Z",
  };
}

function dnvCase(requestedScope: ReturnType<typeof caseScope>) {
  return {
    moi: requestedScope.moi,
    pop_frq_points: 0,
    case_proband_info: {
      phenotypes: [{ code: "HP:0001250", name: "Seizure" }],
      pheno_specificity_for_gene: "SPECIFIC",
      confirmed_parental_relationship: "UNKNOWN",
      all_relevant_genes_tested: "TRUE",
    },
    vbc: { id: requestedScope.variant_id, zygosity: "HET" },
  };
}

function altCase(requestedScope: ReturnType<typeof caseScope>, workflow: "CLN_ALTV" | "CLN_ALTG") {
  return {
    moi: requestedScope.moi,
    case_proband_info: workflow === "CLN_ALTV" ? { pheno_severity: "MONO_EQ_EXPECTED" } : {},
    vbc: { id: requestedScope.variant_id, zygosity: "HET" },
    additional_variant_exists: "TRUE",
    additional_variants: [
      {
        id: `ga4gh:VA.alternate-${requestedScope.scope_id}`,
        gene: { symbol: "OTHER", mde_associated_gene: "OTHER" },
        zygosity: "HET",
        ...(workflow === "CLN_ALTV"
          ? { phase_in_ref_to_vbc: "TRANS", phase_confidence: "HIGH" }
          : {}),
        classification: "LP",
      },
    ],
  };
}

async function runCaseAudit(
  workspace: string,
  scopes: readonly Record<string, unknown>[],
  observations: readonly Record<string, unknown>[],
  runId: string,
) {
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_case_audit",
    runId,
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify(scopes),
      svcv4_case_observations_json: JSON.stringify(observations),
    },
    protectedSessionVariables: ["svcv4_scopes_json", "svcv4_case_observations_json"],
  });
  if (!response.ok) throw new Error(response.error);
  return response.result.rows as Array<Record<string, unknown>>;
}

test("POP_FRQ evaluator policy pins its ordered SQL and configuration definition", async () => {
  const inputs = [
    "data/svcv4_numeric_thresholds.csv",
    "data/svcv4_population_bound_policy.csv",
    "relations/svcv4_population_observations.sql",
    "relations/svcv4_disease_frequency_observations.sql",
    "relations/svcv4_pop_frq_lines.sql",
  ];
  const digest = createHash("sha256").update("svcv4-pop-frq-method-definition-v2\n");
  for (const input of inputs) digest.update(await fs.readFile(join(fixtureRoot, input)));

  const policy = await fs.readFile(join(fixtureRoot, "data", "svcv4_evaluator_policy.csv"), "utf8");
  const [header, row] = policy.trim().split("\n").map((line) => line.split(","));
  const configured = row[header.indexOf("method_definition_digest")];
  assert.equal(configured, `sha256:${digest.digest("hex")}`);
});

test("SVCv4 case policy pins applicability, normalization, audit, and operation SQL", async () => {
  const inputs = [
    "data/svcv4_case_applicability.csv",
    "relations/svcv4_case_observations.sql",
    "relations/svcv4_case_input_audit.sql",
    "operations/svcv4_case_audit.sql",
  ];
  const digest = createHash("sha256").update("svcv4-case-contract-definition-v1\n");
  for (const input of inputs) digest.update(await fs.readFile(join(fixtureRoot, input)));

  const policy = await fs.readFile(join(fixtureRoot, "data", "svcv4_case_contract_policy.csv"), "utf8");
  const [header, row] = policy.trim().split("\n").map((line) => line.split(","));
  const configured = row[header.indexOf("contract_definition_digest")];
  assert.equal(configured, `sha256:${digest.digest("hex")}`);
});

test("SVCv4 source-backed score caps preserve directional and provisional bounds", async () => {
  const csv = await fs.readFile(join(fixtureRoot, "data", "svcv4_score_nodes.csv"), "utf8");
  const [headerLine, ...rowLines] = csv.trim().split("\n");
  const header = headerLine.split(",");
  const rows = new Map(rowLines.map((line) => {
    const values = line.split(",");
    return [values[header.indexOf("node_code")], Object.fromEntries(header.map((name, index) => [name, values[index]]))];
  }));
  const bounds = (code: string) => {
    const row = rows.get(code);
    return row && { min: row.min_score, max: row.max_score, status: row.implementation_status };
  };

  assert.deepEqual(bounds("CLN_UAF"), { min: "", max: "0", status: "specified_not_implemented" });
  assert.deepEqual(bounds("CLN_ALT"), { min: "", max: "0", status: "specified_not_implemented" });
  assert.deepEqual(bounds("CLN_AFF"), { min: "0", max: "", status: "specified_not_implemented" });
  assert.deepEqual(bounds("CLN_DNV"), { min: "0", max: "12", status: "specified_not_implemented" });
  assert.deepEqual(bounds("CLN_CCS"), { min: "", max: "", status: "underspecified" });
  assert.deepEqual(bounds("SPL_SPA"), { min: "-6", max: "0", status: "specified_not_implemented" });
  assert.deepEqual(bounds("NUL_PRD"), { min: "0", max: "10", status: "specified_not_implemented" });
});

test("SVCv4 scope formation requires admitted gene-disease-MOI evidence and preserves failures", async () => {
  const workspace = await copyFixture();
  const candidateBase = {
    record_kind: "variant",
    case_id: "CASE-SCOPE-001",
    variant_key: "17-43093464-A-T",
    gene_id: "HGNC:GENEB",
    gene: "GENEB",
    hypothesis_rank: 1,
    assembly: "GRCh38",
    chrom: "17",
    pos: 43093464,
    ref: "A",
    alt: "T",
    search_status: "completed",
  };
  const candidates = [
    {
      ...candidateBase,
      disease_ids: ["MONDO:FORMED", "MONDO:PROPOSED", "MONDO:INVALID", "MONDO:MISSING"],
    },
    {
      ...candidateBase,
      variant_key: "missing-coordinate",
      pos: null,
      disease_ids: ["MONDO:FORMED"],
    },
  ];
  const modelSource = (itemId: string, diseaseId: string, admissionState = "accepted") => ({
    item_id: itemId,
    gene_id: "HGNC:GENEB",
    disease_id: diseaseId,
    moi: "AD",
    admission_state: admissionState,
    source_id: "disease-model-source",
    source_version: "2026-07",
    source_uri: `https://example.test/disease-model/${itemId}`,
    source_digest: `sha256:${"b".repeat(64)}`,
    observed_at: "2026-07-14T08:00:00Z",
  });
  const diseaseModels = [
    modelSource("model:formed:1", "MONDO:FORMED"),
    modelSource("model:formed:2", "MONDO:FORMED"),
    modelSource("model:proposed", "MONDO:PROPOSED", "proposed"),
    { ...modelSource("model:invalid", "MONDO:INVALID"), source_digest: null },
  ];
  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_form_scopes",
    runId: "svcv4-form-scopes",
    protectedSessionBindings: {
      case_id: "CASE-SCOPE-001",
      candidate_variant_search_json: JSON.stringify(candidates),
      candidate_variant_search_run_id: "analysis-scope.variant-search",
      candidate_variant_search_result_digest: `sha256:${"a".repeat(64)}`,
      svcv4_disease_model_observations_json: JSON.stringify(diseaseModels),
      svcv4_allow_provisional: true,
    },
    protectedSessionVariables: [
      "case_id",
      "candidate_variant_search_json",
      "candidate_variant_search_run_id",
      "candidate_variant_search_result_digest",
      "svcv4_disease_model_observations_json",
      "svcv4_allow_provisional",
    ],
  });
  if (!response.ok) throw new Error(response.error);
  const rows = response.result.rows as Array<Record<string, unknown>>;
  const formed = rows.filter((row) => row.formation_state === "formed");
  assert.equal(formed.length, 1, "corroborating evidence for one MOI produces one exact scope");
  assert.match(String(formed[0]?.variant_id), /^urn:pi-bio:allele:sha256:[0-9a-f]{64}$/);
  assert.equal(formed[0]?.variant_identifier_scheme, "pi-bio.assembly-allele.v1");
  assert.deepEqual(formed[0]?.disease_model_item_ids, ["model:formed:1", "model:formed:2"]);
  const scopeJson = typeof formed[0]?.scope_json === "string"
    ? JSON.parse(formed[0].scope_json)
    : formed[0]?.scope_json;
  assert.deepEqual(scopeJson && {
    scope_id: scopeJson.scope_id,
    variant_id: scopeJson.variant_id,
    gene_id: scopeJson.gene_id,
    disease_id: scopeJson.disease_id,
    moi: scopeJson.moi,
    case_id: scopeJson.case_id,
    evaluation_mode: scopeJson.evaluation_mode,
    allow_provisional: scopeJson.allow_provisional,
    expected_method_codes: scopeJson.expected_method_codes,
  }, {
    scope_id: formed[0]?.scope_id,
    variant_id: formed[0]?.variant_id,
    gene_id: "HGNC:GENEB",
    disease_id: "MONDO:FORMED",
    moi: "AD",
    case_id: null,
    evaluation_mode: "case_independent",
    allow_provisional: true,
    expected_method_codes: ["POP_FRQ"],
  });

  const failures = rows.filter((row) => row.formation_state === "not_formed");
  assert.ok(failures.some((row) => row.disease_id === "MONDO:PROPOSED" && row.reason_code === "disease_model_evidence_not_admitted"));
  assert.ok(failures.some((row) => row.disease_id === "MONDO:INVALID" && row.reason_code === "incomplete_disease_model_source_identity"));
  assert.ok(failures.some((row) => row.disease_id === "MONDO:MISSING" && row.reason_code === "disease_model_evidence_missing"));
  assert.ok(failures.some((row) => row.variant_id == null && row.reason_code === "missing_exact_variant_identity"));

  const selection = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_select_profile",
    runId: "svcv4-select-formed-scope",
    protectedSessionBindings: { svcv4_scopes_json: JSON.stringify([scopeJson]) },
    protectedSessionVariables: ["svcv4_scopes_json"],
  });
  if (!selection.ok) throw new Error(selection.error);
  assert.equal((selection.result.rows[0] as Record<string, unknown>).selection_status, "selected");
});

test("SVCv4 scope envelopes reject duplicates, unknown fields, and JSON coercions", async () => {
  const workspace = await copyFixture();
  const missingMode = { ...scope("missing-mode") } as Record<string, unknown>;
  delete missingMode.evaluation_mode;
  const missingCase = { ...caseScope("missing-case", "CLN_DNV") } as Record<string, unknown>;
  delete missingCase.case_id;
  const duplicate = scope("duplicate-scope");
  const scopes = [
    scope("valid-scope"),
    { ...scope("unknown-field"), surprise: true },
    { ...scope("wrong-type"), allow_provisional: "true" },
    { ...scope("method-type"), expected_method_codes: ["POP_FRQ", 7] },
    { ...scope("missing-methods"), expected_method_codes: [] },
    { ...scope("duplicate-method"), expected_method_codes: ["POP_FRQ", "POP_FRQ"] },
    missingMode,
    missingCase,
    duplicate,
    { ...duplicate },
  ];

  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_select_profile",
    runId: "svcv4-scope-contract",
    protectedSessionBindings: { svcv4_scopes_json: JSON.stringify(scopes) },
    protectedSessionVariables: ["svcv4_scopes_json"],
  });
  if (!response.ok) throw new Error(response.error);
  const rows = new Map(
    (response.result.rows as Array<Record<string, unknown>>).map((row) => [String(row.scope_id), row]),
  );

  assert.equal(rows.get("valid-scope")?.selection_status, "selected");
  assert.equal(rows.get("unknown-field")?.invalid_reason, "unknown_scope_fields");
  assert.equal(rows.get("wrong-type")?.invalid_reason, "invalid_scope_field_types");
  assert.equal(rows.get("method-type")?.invalid_reason, "invalid_scope_field_types");
  assert.equal(rows.get("missing-methods")?.invalid_reason, "missing_expected_method_codes");
  assert.equal(rows.get("duplicate-method")?.invalid_reason, "duplicate_expected_method_code");
  assert.equal(rows.get("missing-mode")?.invalid_reason, "missing_evaluation_mode");
  assert.equal(rows.get("missing-case")?.invalid_reason, "missing_case_id");
  assert.equal(rows.get("duplicate-scope")?.invalid_reason, "duplicate_scope_id");
  assert.equal(rows.get("duplicate-scope")?.scope_record_count, 2);
  assert.equal(
    (response.result.rows as Array<Record<string, unknown>>).filter((row) => row.scope_id === "duplicate-scope").length,
    1,
    "duplicate scope identifiers collapse to one invalid audit row",
  );
});

test("SVCv4 case capture preserves missing, null, UNKNOWN, applicability, and nested workflow semantics", async () => {
  const workspace = await copyFixture();
  const dnvValid = caseScope("dnv-valid", "CLN_DNV");
  const dnvNull = caseScope("dnv-null", "CLN_DNV");
  const dnvForbidden = caseScope("dnv-forbidden", "CLN_DNV");
  const sourceMissing = caseScope("source-missing", "CLN_DNV");
  const scopeMismatch = caseScope("scope-mismatch", "CLN_DNV");
  const altvValid = caseScope("altv-valid", "CLN_ALTV");
  const altvAr = caseScope("altv-ar", "CLN_ALTV", "AR");
  const altgSeverity = caseScope("altg-severity", "CLN_ALTG");
  const affMissingCompound = caseScope("aff-missing-compound", "CLN_AFF", "AR");
  const affBadCompound = caseScope("aff-bad-compound", "CLN_AFF", "AR");
  const affEmptyCompound = caseScope("aff-empty-compound", "CLN_AFF", "AR");
  const affWrongContext = caseScope("aff-wrong-context", "CLN_AFF", "AD");
  const unknownNested = caseScope("unknown-nested", "CLN_DNV");
  const wrongTypes = caseScope("wrong-types", "CLN_DNV");
  const invalidClinicalShape = caseScope("invalid-clinical-shape", "CLN_DNV");
  const noObservation = caseScope("no-observation", "CLN_DNV");
  const missingItem = caseScope("missing-item", "CLN_DNV");
  const duplicateOne = caseScope("duplicate-one", "CLN_DNV");
  const duplicateTwo = caseScope("duplicate-two", "CLN_DNV");
  const caseIndependent = { ...caseScope("case-independent", "CLN_DNV"), evaluation_mode: "case_independent" };
  const scopes = [
    dnvValid,
    dnvNull,
    dnvForbidden,
    sourceMissing,
    scopeMismatch,
    altvValid,
    altvAr,
    altgSeverity,
    affMissingCompound,
    affBadCompound,
    affEmptyCompound,
    affWrongContext,
    unknownNested,
    wrongTypes,
    invalidClinicalShape,
    noObservation,
    missingItem,
    duplicateOne,
    duplicateTwo,
    caseIndependent,
  ];

  const affBase = (requestedScope: ReturnType<typeof caseScope>) => ({
    moi: "AR",
    pop_frq_points: 0,
    case_proband_info: {
      pheno_specificity_for_gene: "CONSISTENT",
      all_relevant_genes_tested: "UNKNOWN",
    },
    vbc: { id: requestedScope.variant_id, zygosity: "HET" },
    additional_variant_exists: "FALSE",
  });
  const observations: Record<string, unknown>[] = [
    caseEnvelope(dnvValid, "CLN_DNV", dnvCase(dnvValid)),
    caseEnvelope(dnvNull, "CLN_DNV", {
      ...dnvCase(dnvNull),
      case_proband_info: {
        ...dnvCase(dnvNull).case_proband_info,
        confirmed_parental_relationship: null,
      },
    }),
    caseEnvelope(dnvForbidden, "CLN_DNV", {
      ...dnvCase(dnvForbidden),
      additional_variants: null,
    }),
    (() => {
      const envelope = caseEnvelope(sourceMissing, "CLN_DNV", dnvCase(sourceMissing));
      delete (envelope as { source_digest?: string }).source_digest;
      return envelope;
    })(),
    caseEnvelope(scopeMismatch, "CLN_DNV", {
      ...dnvCase(scopeMismatch),
      vbc: { id: "ga4gh:VA.not-the-requested-variant", zygosity: "HET" },
    }),
    caseEnvelope(altvValid, "CLN_ALTV", altCase(altvValid, "CLN_ALTV")),
    caseEnvelope(altvAr, "CLN_ALTV", altCase(altvAr, "CLN_ALTV")),
    caseEnvelope(altgSeverity, "CLN_ALTG", {
      ...altCase(altgSeverity, "CLN_ALTG"),
      case_proband_info: { pheno_severity: "BIALLELIC_LT_EXPECTED" },
    }),
    caseEnvelope(affMissingCompound, "CLN_AFF", affBase(affMissingCompound)),
    caseEnvelope(affBadCompound, "CLN_AFF", {
      ...affBase(affBadCompound),
      compound_het_variant: {
        id: "ga4gh:VA.compound",
        zygosity: "HOM",
        phase_in_ref_to_vbc: "CIS",
        phase_confidence: "HIGH",
        classification: "LP",
      },
    }),
    caseEnvelope(affEmptyCompound, "CLN_AFF", {
      ...affBase(affEmptyCompound),
      compound_het_variant: {},
    }),
    caseEnvelope(affWrongContext, "CLN_AFF", {
      ...affBase(affWrongContext),
      moi: "AD",
      compound_het_variant: {
        id: "ga4gh:VA.compound-not-applicable",
        zygosity: "HET",
        phase_in_ref_to_vbc: "TRANS",
        phase_confidence: "HIGH",
        classification: "LP",
      },
    }),
    caseEnvelope(unknownNested, "CLN_DNV", {
      ...dnvCase(unknownNested),
      case_proband_info: { ...dnvCase(unknownNested).case_proband_info, surprise: true },
    }),
    caseEnvelope(wrongTypes, "CLN_DNV", {
      ...dnvCase(wrongTypes),
      pop_frq_points: "0",
    }),
    caseEnvelope(invalidClinicalShape, "CLN_DNV", {
      ...dnvCase(invalidClinicalShape),
      case_proband_info: {
        ...dnvCase(invalidClinicalShape).case_proband_info,
        age: { qualifier: "RANGE", unit: "YEAR", min: 8, max: 3 },
        phenotypes: [{ code: "NOT-HPO" }],
      },
    }),
    (() => {
      const envelope = caseEnvelope(missingItem, "CLN_DNV", dnvCase(missingItem));
      delete (envelope as { item_id?: string }).item_id;
      return envelope;
    })(),
    caseEnvelope(duplicateOne, "CLN_DNV", dnvCase(duplicateOne), "duplicate-case-item"),
    caseEnvelope(duplicateTwo, "CLN_DNV", dnvCase(duplicateTwo), "duplicate-case-item"),
    caseEnvelope(caseIndependent as ReturnType<typeof caseScope>, "CLN_DNV", dnvCase(caseIndependent as ReturnType<typeof caseScope>)),
    {
      ...caseEnvelope(caseScope("orphan", "CLN_DNV"), "CLN_DNV", dnvCase(caseScope("orphan", "CLN_DNV"))),
      scope_id: "orphan",
    },
  ];

  const rows = await runCaseAudit(workspace, scopes, observations, "svcv4-case-capture-semantics");
  const byScope = new Map(rows.map((row) => [String(row.scope_id), row]));
  const issues = (id: string) => byScope.get(id)?.issues as string[];

  assert.equal(byScope.get("dnv-valid")?.audit_status, "complete", "UNKNOWN is a captured tri-state value");
  assert.equal(byScope.get("altv-valid")?.audit_status, "complete");
  assert.equal(
    byScope.get("dnv-valid")?.contract_definition_digest,
    "sha256:09f6e46bded0dd3fc533a1b9b5a11f9d53297c02b27029b9b824fe6cde1b81bb",
  );
  assert.equal("case_json" in (byScope.get("dnv-valid") ?? {}), false, "raw case payloads stay out of audit output");
  assert.equal(byScope.get("dnv-null")?.audit_status, "incomplete");
  assert.ok(issues("dnv-null").includes("incomplete:required_field_null:case_proband_info.confirmed_parental_relationship"));
  assert.ok(issues("dnv-forbidden").includes("invalid:not_applicable_field_present:case.additional_variants"));
  assert.ok(issues("source-missing").includes("invalid:incomplete_source_identity"));
  assert.ok(issues("scope-mismatch").includes("invalid:scope_variant_mismatch"));
  assert.ok(issues("altv-ar").includes("invalid:altv_moi_not_supported"));
  assert.ok(issues("altg-severity").includes("invalid:excluded_enum_value:case_proband_info.pheno_severity"));
  assert.ok(issues("aff-missing-compound").includes("incomplete:compound_het_context_missing"));
  assert.ok(issues("aff-bad-compound").includes("invalid:fixed_value_mismatch:compound_het_variant.zygosity"));
  assert.ok(issues("aff-bad-compound").includes("invalid:fixed_value_mismatch:compound_het_variant.phase_in_ref_to_vbc"));
  assert.ok(issues("aff-empty-compound").includes("incomplete:required_field_missing:compound_het_variant.id"));
  assert.ok(issues("aff-empty-compound").includes("incomplete:required_field_missing:compound_het_variant.phase_in_ref_to_vbc"));
  assert.ok(issues("aff-wrong-context").includes("invalid:compound_het_context_not_applicable"));
  assert.ok(issues("unknown-nested").includes("invalid:unknown_field:case_proband_info.surprise"));
  assert.ok(issues("wrong-types").includes("invalid:field_type_mismatch:case.pop_frq_points"));
  assert.ok(issues("invalid-clinical-shape").includes("invalid:invalid_age_range"));
  assert.ok(issues("invalid-clinical-shape").includes("invalid:invalid_hpo_identifier:0"));
  assert.deepEqual(issues("no-observation"), ["incomplete:case_observation_missing"]);
  assert.ok(issues("missing-item").includes("invalid:item_id_missing"));
  assert.ok(issues("duplicate-one").includes("invalid:duplicate_item_id"));
  assert.ok(issues("duplicate-two").includes("invalid:duplicate_item_id"));
  assert.ok(issues("case-independent").includes("invalid:case_observation_on_case_independent_scope"));
  assert.ok(issues("orphan").includes("invalid:scope_not_requested"));
});

test("all five public SVCv4 CLN capture workflows have complete positive vectors", async () => {
  const workspace = await copyFixture();
  const aff = caseScope("positive-aff", "CLN_AFF", "AR");
  const dnv = caseScope("positive-dnv", "CLN_DNV");
  const altv = caseScope("positive-altv", "CLN_ALTV");
  const altg = caseScope("positive-altg", "CLN_ALTG");
  const uaf = caseScope("positive-uaf", "CLN_UAF");
  const observations = [
    caseEnvelope(aff, "CLN_AFF", {
      moi: "AR",
      pop_frq_points: 0,
      case_proband_info: {
        pheno_specificity_for_gene: "CONSISTENT",
        all_relevant_genes_tested: "UNKNOWN",
      },
      vbc: { id: aff.variant_id, zygosity: "HET" },
      compound_het_variant: {
        id: "ga4gh:VA.positive-compound",
        zygosity: "HET",
        phase_in_ref_to_vbc: "TRANS",
        phase_confidence: "HIGH",
        classification: "LP",
      },
      additional_variant_exists: "FALSE",
    }),
    caseEnvelope(dnv, "CLN_DNV", dnvCase(dnv)),
    caseEnvelope(altv, "CLN_ALTV", altCase(altv, "CLN_ALTV")),
    caseEnvelope(altg, "CLN_ALTG", altCase(altg, "CLN_ALTG")),
    caseEnvelope(uaf, "CLN_UAF", {
      moi: "AD",
      case_proband_info: { age_matched_penetrance: "NEAR_100" },
      vbc: { id: uaf.variant_id, zygosity: "HET" },
    }),
  ];

  const rows = await runCaseAudit(
    workspace,
    [aff, dnv, altv, altg, uaf],
    observations,
    "svcv4-case-positive-workflows",
  );
  assert.deepEqual(
    rows.map((row) => [row.scope_id, row.method_code, row.audit_status]),
    [
      ["positive-aff", "CLN_AFF", "complete"],
      ["positive-altg", "CLN_ALT", "complete"],
      ["positive-altv", "CLN_ALT", "complete"],
      ["positive-dnv", "CLN_DNV", "complete"],
      ["positive-uaf", "CLN_UAF", "complete"],
    ],
  );
});

test("POP_FRQ preserves missing, null, zero-count, covered-absence, and de novo semantics", async () => {
  const workspace = await copyFixture();
  const scopes = [
    scope("measured"),
    scope("measured-zero"),
    scope("measured-null"),
    scope("measured-without-measure"),
    scope("mixed-valid-and-unknown"),
    scope("not-captured"),
    scope("zero-small-panel"),
    scope("zero-large-panel"),
    scope("covered-absence"),
    scope("absence-without-null"),
    scope("absence-with-synthetic-counts"),
    scope("absence-with-nominal-size-only"),
    scope("absence-with-inadequate-callability"),
    scope("scope-identity-mismatch"),
    scope("source-invalid"),
    scope("source-filtered"),
    scope("unknown-field"),
    scope("string-number"),
    scope("missing-item"),
    scope("duplicate-item"),
    scope("de-novo"),
  ];
  const byId = new Map(scopes.map((item) => [item.scope_id, item]));
  const source = (id: string, itemId: string) => populationSource(byId.get(id)!, itemId);
  const observations = [
    {
      ...source("measured", "measured-low"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.00009,
      allele_count: 9,
      allele_number: 100000,
    },
    {
      ...source("measured", "measured-high"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
      allele_count: 2,
      allele_number: 10000,
    },
    {
      ...source("measured-zero", "measured-zero"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0,
    },
    {
      ...source("measured-null", "measured-null"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: null,
    },
    {
      ...source("measured-without-measure", "measured-without-measure"),
      frequency_state: "measured",
      allele_frequency: 0.0002,
    },
    {
      ...source("mixed-valid-and-unknown", "mixed-valid"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("mixed-valid-and-unknown", "mixed-unknown"),
      frequency_state: "unknown",
    },
    {
      ...source("not-captured", "not-captured"),
      frequency_state: "not_captured",
    },
    {
      ...source("zero-small-panel", "zero-small-panel"),
      frequency_state: "counted_zero",
      allele_frequency: 0,
      allele_count: 0,
      allele_number: 10000,
      cohort_sample_count: 250000,
      denominator_semantics: "variant_record_post_qc_alleles",
      denominator_method: "source_variant_record_an",
    },
    {
      ...source("zero-large-panel", "zero-large-panel"),
      frequency_state: "counted_zero",
      allele_frequency: 0,
      allele_count: 0,
      allele_number: 500000,
      cohort_sample_count: 250000,
      denominator_semantics: "variant_record_post_qc_alleles",
      denominator_method: "source_variant_record_an",
    },
    {
      ...source("covered-absence", "covered-absence"),
      frequency_state: "not_observed",
      allele_frequency: null,
      allele_count: null,
      allele_number: null,
      callable_allele_number: 500000,
      cohort_sample_count: 250000,
      denominator_semantics: "locus_post_qc_callable_alleles",
      denominator_method: "source_all_sites_post_qc_an",
    },
    {
      ...source("absence-without-null", "absence-without-null"),
      frequency_state: "not_observed",
      allele_count: null,
      allele_number: null,
      callable_allele_number: 500000,
      denominator_semantics: "locus_post_qc_callable_alleles",
      denominator_method: "source_all_sites_post_qc_an",
    },
    {
      ...source("absence-with-synthetic-counts", "absence-with-synthetic-counts"),
      frequency_state: "not_observed",
      allele_frequency: null,
      allele_count: 0,
      allele_number: 500000,
      callable_allele_number: 500000,
      denominator_semantics: "locus_post_qc_callable_alleles",
      denominator_method: "source_all_sites_post_qc_an",
    },
    {
      ...source("absence-with-nominal-size-only", "absence-with-nominal-size-only"),
      frequency_state: "not_observed",
      allele_frequency: null,
      allele_count: null,
      allele_number: null,
      cohort_sample_count: 250000,
      denominator_semantics: "locus_post_qc_callable_alleles",
      denominator_method: "nominal_panel_size_only",
    },
    {
      ...source("absence-with-inadequate-callability", "absence-with-inadequate-callability"),
      frequency_state: "not_observed",
      allele_frequency: null,
      allele_count: null,
      allele_number: null,
      callable_allele_number: 500000,
      cohort_sample_count: 250000,
      coverage_state: "inadequate",
      denominator_semantics: "locus_post_qc_callable_alleles",
      denominator_method: "source_all_sites_post_qc_an",
    },
    {
      ...source("scope-identity-mismatch", "scope-identity-mismatch"),
      variant_id: "ga4gh:VA.different",
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("source-invalid", "source-invalid"),
      source_uri: "",
      source_digest: "not-a-digest",
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("source-filtered", "source-filtered"),
      source_filter_state: "failed",
      source_filters: ["discrepant_frequencies"],
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("unknown-field", "unknown-field"),
      unsupported_frequency_claim: 0,
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("string-number", "string-number"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: "0.0002",
    },
    {
      ...source("missing-item", ""),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("duplicate-item", "duplicate-population-item"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0001,
    },
    {
      ...source("duplicate-item", "duplicate-population-item"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
    },
    {
      ...source("de-novo", "de-novo"),
      frequency_state: "measured",
      frequency_measure: "point_estimate",
      allele_frequency: 0.0002,
      inheritance: "de_novo",
    },
  ];

  const response = await runPop(workspace, scopes, observations, "svcv4-frequency-semantics");
  const rows = new Map(
    (response.result.rows as Array<Record<string, unknown>>).map((row) => [String(row.scope_id), row]),
  );

  assert.deepEqual(
    {
      state: rows.get("measured")?.evaluation_state,
      score: rows.get("measured")?.score,
      measurement: rows.get("measured")?.measurement_value,
      evidence: rows.get("measured")?.evidence_item_ids,
    },
    {
      state: "scored",
      score: -3,
      measurement: 0.2,
      evidence: ["disease-frequency:measured", "measured-high"],
    },
    "the greatest admitted positive frequency ratio is scored",
  );
  assert.equal(rows.get("measured-zero")?.evaluation_state, "not_evaluated");
  assert.deepEqual(rows.get("measured-zero")?.observation_errors, ["invalid_measured_allele_frequency"]);
  assert.deepEqual(rows.get("measured-null")?.observation_errors, ["measured_frequency_missing"]);
  assert.deepEqual(rows.get("measured-without-measure")?.observation_errors, ["unsupported_frequency_measure"]);
  assert.equal(rows.get("mixed-valid-and-unknown")?.evaluation_state, "not_evaluated");
  assert.equal(rows.get("mixed-valid-and-unknown")?.reason_code, "population_frequency_unknown");
  assert.equal(rows.get("not-captured")?.reason_code, "population_frequency_not_captured");

  const small = rows.get("zero-small-panel");
  assert.equal(small?.evaluation_state, "not_evaluated");
  assert.equal(small?.bound_decision, "bound_crosses_scoring_threshold");
  assert.ok(Math.abs(Number(small?.derived_upper_frequency_bound) - 0.00029952835977664627) < 1e-15);

  for (const id of ["zero-large-panel", "covered-absence"]) {
    const row = rows.get(id);
    assert.equal(row?.evaluation_state, "no_evidence");
    assert.equal(row?.score, null);
    assert.equal(row?.bound_decision, "bound_within_zero_score_interval");
    assert.equal(row?.applied_bound_method, "zero_count_binomial_one_sided_exact");
    assert.equal(row?.applied_confidence_level, 0.95);
  }
  assert.equal(rows.get("zero-large-panel")?.measurement_state, "counted_zero");
  assert.equal(rows.get("covered-absence")?.measurement_state, "not_observed");
  assert.equal(rows.get("covered-absence")?.source_allele_number, null);
  assert.equal(rows.get("covered-absence")?.callable_allele_number, 500000);
  assert.equal(rows.get("covered-absence")?.bound_allele_number, 500000);
  assert.equal(rows.get("covered-absence")?.cohort_sample_count, 250000);
  assert.deepEqual(rows.get("absence-without-null")?.observation_errors, ["not_observed_frequency_must_be_null"]);
  assert.deepEqual(rows.get("absence-with-synthetic-counts")?.observation_errors, [
    "not_observed_variant_counts_must_be_null",
  ]);
  assert.deepEqual(rows.get("absence-with-nominal-size-only")?.observation_errors, [
    "invalid_not_observed_callable_denominator",
  ]);
  assert.deepEqual(rows.get("absence-with-inadequate-callability")?.observation_errors, [
    "population_coverage_not_adequate",
  ]);
  assert.equal(rows.get("absence-with-inadequate-callability")?.derived_upper_frequency_bound, null);
  assert.deepEqual(rows.get("scope-identity-mismatch")?.observation_errors, ["scope_identity_mismatch"]);
  assert.deepEqual(rows.get("source-invalid")?.observation_errors, ["incomplete_source_identity"]);
  assert.deepEqual(rows.get("source-filtered")?.observation_errors, ["population_source_not_filter_passed"]);
  assert.deepEqual(rows.get("unknown-field")?.observation_errors, ["unknown_observation_fields"]);
  assert.deepEqual(rows.get("string-number")?.observation_errors, ["invalid_observation_field_types"]);
  assert.deepEqual(rows.get("missing-item")?.observation_errors, ["missing_item_id"]);
  assert.deepEqual(rows.get("duplicate-item")?.observation_errors, ["duplicate_item_id"]);
  assert.equal(rows.get("de-novo")?.reason_code, "case_inheritance_on_population_observation");
});

test("POP_FRQ keeps disease-frequency derivation separate, singular, and source-pinned", async () => {
  const workspace = await copyFixture();
  const scopes = [
    scope("disease-frequency-missing"),
    scope("disease-frequency-string"),
    scope("disease-frequency-ambiguous"),
    scope("disease-frequency-unadmitted"),
    scope("disease-frequency-scope-drift"),
  ];
  const observations = scopes.map((requestedScope) => ({
    ...populationSource(requestedScope, `population:${requestedScope.scope_id}`),
    frequency_state: "measured",
    frequency_measure: "point_estimate",
    allele_frequency: 0.0002,
    allele_count: 2,
    allele_number: 10000,
  }));
  const byId = new Map(scopes.map((requestedScope) => [requestedScope.scope_id, requestedScope]));
  const diseaseEvidence = [
    {
      ...diseaseFrequencySource(byId.get("disease-frequency-string")!),
      disease_max_credible_frequency: "0.001",
    },
    diseaseFrequencySource(byId.get("disease-frequency-ambiguous")!, "disease-frequency:ambiguous:1"),
    diseaseFrequencySource(byId.get("disease-frequency-ambiguous")!, "disease-frequency:ambiguous:2"),
    {
      ...diseaseFrequencySource(byId.get("disease-frequency-unadmitted")!),
      admission_state: "proposed",
    },
    {
      ...diseaseFrequencySource(byId.get("disease-frequency-scope-drift")!),
      variant_id: "ga4gh:VA.different",
    },
  ];

  const response = await runPop(
    workspace,
    scopes,
    observations,
    "svcv4-disease-frequency-semantics",
    diseaseEvidence,
  );
  const rows = new Map(
    (response.result.rows as Array<Record<string, unknown>>).map((row) => [String(row.scope_id), row]),
  );

  assert.equal(rows.get("disease-frequency-missing")?.reason_code, "disease_frequency_evidence_missing");
  assert.deepEqual(rows.get("disease-frequency-string")?.disease_frequency_errors, [
    "invalid_disease_frequency_field_types",
  ]);
  assert.equal(rows.get("disease-frequency-ambiguous")?.reason_code, "disease_frequency_evidence_ambiguous");
  assert.deepEqual(rows.get("disease-frequency-unadmitted")?.disease_frequency_errors, [
    "disease_frequency_evidence_not_admitted",
  ]);
  assert.deepEqual(rows.get("disease-frequency-scope-drift")?.disease_frequency_errors, [
    "disease_frequency_scope_identity_mismatch",
  ]);
  assert.ok([...rows.values()].every((row) => row.evaluation_state === "not_evaluated"));
});

test("audited POP_FRQ can roll up but the provisional profile cannot emit a partial clinical class", async () => {
  const workspace = await copyFixture();
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const requestedScope = scope("classification-gate");
  const observation = {
    ...populationSource(requestedScope, "population-line"),
    frequency_state: "measured",
    frequency_measure: "point_estimate",
    allele_frequency: 0.0002,
    allele_count: 2,
    allele_number: 10000,
  };
  const pop = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_pop_frq",
    runId: "svcv4-pop-producer",
    cas,
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify([requestedScope]),
      svcv4_population_observations_json: JSON.stringify([observation]),
      svcv4_disease_frequency_observations_json: JSON.stringify([
        diseaseFrequencySource(requestedScope),
      ]),
    },
    protectedSessionVariables: [
      "svcv4_scopes_json",
      "svcv4_population_observations_json",
      "svcv4_disease_frequency_observations_json",
    ],
  });
  if (!pop.ok) throw new Error(pop.error);
  assert.equal(pop.ok, true);
  assert.ok(pop.casRefs);
  const line = {
    ...(pop.result.rows[0] as Record<string, unknown>),
    producer_run_id: pop.runId,
    producer_result_digest: pop.casRefs!.result,
    admission_state: "accepted",
  };
  const common = {
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    cas,
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify([requestedScope]),
      svcv4_evidence_lines_json: JSON.stringify([line]),
    },
    protectedSessionVariables: ["svcv4_scopes_json", "svcv4_evidence_lines_json"],
  };

  const audit = await runBioOperationFromManifest({
    ...common,
    operationId: "clinical.svcv4_line_audit",
    runId: "svcv4-line-audit",
  });
  if (!audit.ok) throw new Error(audit.error);
  assert.equal(audit.ok, true);
  assert.deepEqual(
    (audit.result.rows[0] as Record<string, unknown>)?.audit_status,
    "complete",
  );

  const rollup = await runBioOperationFromManifest({
    ...common,
    operationId: "clinical.svcv4_score_rollup",
    runId: "svcv4-score-rollup",
  });
  if (!rollup.ok) throw new Error(rollup.error);
  assert.equal(rollup.ok, true);
  const finalNode = (rollup.result.rows as Array<Record<string, unknown>>).find((row) => row.node_code === "FINAL");
  assert.equal(finalNode?.raw_score, -3);
  assert.equal(finalNode?.capped_score, -3);

  const classification = await runBioOperationFromManifest({
    ...common,
    operationId: "clinical.svcv4_classify",
    runId: "svcv4-classification-gate",
  });
  if (!classification.ok) throw new Error(classification.error);
  assert.equal(classification.ok, true);
  const result = classification.result.rows[0] as Record<string, unknown>;
  assert.equal(result.classification_readiness, "method_evaluation_only");
  assert.equal(result.classification_status, "profile_not_ready_for_classification");
  assert.equal(result.final_score, null);
  assert.equal(result.classification, null);

  const auditLine = async (runId: string, candidate: Record<string, unknown>) => {
    const response = await runBioOperationFromManifest({
      ...common,
      operationId: "clinical.svcv4_line_audit",
      runId,
      protectedSessionBindings: {
        svcv4_scopes_json: JSON.stringify([requestedScope]),
        svcv4_evidence_lines_json: JSON.stringify([candidate]),
      },
    });
    if (!response.ok) throw new Error(response.error);
    return response.result.rows[0] as Record<string, unknown>;
  };

  const rejectedRow = await auditLine("svcv4-line-audit-rejects-definition-drift", {
    ...line,
    method_definition_digest: `sha256:${"0".repeat(64)}`,
  });
  assert.equal(rejectedRow.audit_status, "invalid");
  assert.equal(rejectedRow.audit_reason, "evaluator_identity_not_approved");

  const outOfRangeRow = await auditLine("svcv4-line-audit-rejects-out-of-range-score", {
    ...line,
    score: -7,
  });
  assert.equal(outOfRangeRow.audit_status, "invalid");
  assert.equal(outOfRangeRow.audit_reason, "score_below_configured_minimum");

  const zeroOnNoEvidence = await auditLine("svcv4-line-audit-rejects-zero-on-no-evidence", {
    ...line,
    evaluation_state: "no_evidence",
    score: 0,
    reason_code: "completed_search_no_support",
  });
  assert.equal(zeroOnNoEvidence.audit_reason, "score_on_unscored_line");

  const unsupportedNoEvidence = await auditLine("svcv4-line-audit-requires-no-evidence-support", {
    ...line,
    evaluation_state: "no_evidence",
    score: null,
    reason_code: "completed_search_no_support",
    evidence_item_ids: [],
  });
  assert.equal(unsupportedNoEvidence.audit_reason, "evidence_line_without_evidence_items");

  const unexplainedNotEvaluated = await auditLine("svcv4-line-audit-requires-abstention-reason", {
    ...line,
    evaluation_state: "not_evaluated",
    score: null,
    reason_code: null,
  });
  assert.equal(unexplainedNotEvaluated.audit_reason, "unscored_line_without_reason");
});

test("score rollup selects the higher uncapped impact branch before applying configured caps", async () => {
  const workspace = await copyFixture();
  const definitionDigest = `sha256:${"b".repeat(64)}`;
  await fs.appendFile(
    join(workspace, "data", "svcv4_evaluator_policy.csv"),
    ["MIS_PRD", "MIS_FXN", "CDS_PRD", "CDS_FXN"]
      .map((method) => [
        "clingen.svcv4.public-draft",
        "2026-07-10",
        method,
        "test.impact_evaluator",
        "1.0.0",
        definitionDigest,
        "active",
        "svcv4-model-pfd-workflows",
      ].join(","))
      .join("\n") + "\n",
  );

  const requestedScope = {
    ...scope("impact-branch"),
    expected_method_codes: ["MIS_PRD", "MIS_FXN", "CDS_PRD", "CDS_FXN"],
  };
  const scores = new Map([
    ["MIS_PRD", 4],
    ["MIS_FXN", 4],
    ["CDS_PRD", 6],
    ["CDS_FXN", 1],
  ]);
  const lines = [...scores].map(([method, scoreValue]) => ({
    line_id: `impact-branch:${method}`,
    scope_id: requestedScope.scope_id,
    variant_id: requestedScope.variant_id,
    gene_id: requestedScope.gene_id,
    disease_id: requestedScope.disease_id,
    moi: requestedScope.moi,
    case_id: null,
    profile_id: "clingen.svcv4.public-draft",
    profile_version: "2026-07-10",
    method_code: method,
    evaluation_state: "scored",
    score: scoreValue,
    reason_code: "test_score",
    evidence_item_ids: [`evidence:${method}`],
    evaluator_id: "test.impact_evaluator",
    evaluator_version: "1.0.0",
    method_definition_digest: definitionDigest,
    producer_run_id: `producer:${method}`,
    producer_result_digest: `sha256:${method.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    admission_state: "accepted",
    branch_group: "impact_path",
    branch_id: method.startsWith("MIS_") ? "missense" : "coding_sequence",
  }));

  const response = await runBioOperationFromManifest({
    cwd: workspace,
    dbPath: ":memory:",
    manifestPath: "svcv4.manifest.json",
    operationId: "clinical.svcv4_score_rollup",
    runId: "svcv4-impact-branch-rollup",
    protectedSessionBindings: {
      svcv4_scopes_json: JSON.stringify([requestedScope]),
      svcv4_evidence_lines_json: JSON.stringify(lines),
    },
    protectedSessionVariables: ["svcv4_scopes_json", "svcv4_evidence_lines_json"],
  });
  if (!response.ok) throw new Error(response.error);
  const rows = response.result.rows as Array<Record<string, unknown>>;

  assert.deepEqual(
    rows.filter((row) => Number(row.node_stage) === 0).map((row) => row.node_code).sort(),
    ["MIS_FXN", "MIS_PRD"],
    "the missense raw total (8) beats the coding-sequence raw total (7)",
  );
  const missense = rows.find((row) => row.node_code === "MIS_PF");
  assert.deepEqual(
    missense && { raw: missense.raw_score, capped: missense.capped_score, applied: missense.cap_applied },
    { raw: 8, capped: 6, applied: true },
    "the winning branch is capped only after selection",
  );
  const finalNode = rows.find((row) => row.node_code === "FINAL");
  assert.equal(finalNode?.capped_score, 6);
});
