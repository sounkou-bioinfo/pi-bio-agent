import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { zipSync } from "fflate";
import { materializeBioEdgesAsOf, openBioStore } from "pi-bio-agent";
import {
  PublishedAcmgBenchmarkInputError,
  buildPublishedAcmgBenchmarkBundle,
  getPublishedAcmgBenchmarkBundle,
  getPublishedAcmgBenchmarkRegistration,
  parseAcmgCriteria,
  parseAcmgCriterionToken,
  readPublishedAcmgWorkbook,
  registerPublishedAcmgWorkbook,
  registerPublishedAcmgWorkbookArchiveFile,
} from "../src/published-acmg-benchmark.js";

const fixturePath = resolve("test/fixtures/published-acmg-workbook.xlsx");
const sourceUri = "urn:doi:10.1126/scitranslmed.adz4172#tables-s1-s13";
const citation = "Contract fixture shaped like Ma et al. supplementary tables S1-S13";

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
}

test("criterion parsing preserves source flags, non-application, caps, and malformed source expressions", () => {
  assert.deepEqual(parseAcmgCriterionToken("##PP1_Strong (not applied)"), {
    raw: "##PP1_Strong (not applied)",
    code: "PP1",
    strength: "strong",
    applied: false,
    sourceFlag: "wrong_raw_score",
    parseStatus: "parsed",
  });
  assert.deepEqual(parseAcmgCriterionToken("PVS1_Moderate (RNA)"), {
    raw: "PVS1_Moderate (RNA)",
    code: "PVS1",
    strength: "moderate",
    applied: true,
    context: "RNA",
    sourceFlag: "none",
    parseStatus: "parsed",
  });
  const capped = parseAcmgCriteria("PS3_Supporting, [PP1_Strong, PP4_Strong] capped at [Strong+Supporting], ");
  assert.equal(capped.length, 2);
  assert.equal(capped[0]?.parseStatus, "parsed");
  assert.equal(capped[1]?.parseStatus, "unparsed");
  assert.equal(capped[1]?.raw, "[PP1_Strong, PP4_Strong] capped at [Strong+Supporting]");
  assert.equal(parseAcmgCriterionToken("PP2_PM2_Supporting").parseStatus, "unparsed");
  assert.equal(parseAcmgCriterionToken("PP1_Definitive").parseStatus, "unparsed");
});

test("XLSX adapter preserves role boundaries and independently recomputes classification concordance", async () => {
  const bytes = await fs.readFile(fixturePath);
  const sheets = await readPublishedAcmgWorkbook(bytes);
  const bundle = buildPublishedAcmgBenchmarkBundle({
    datasetId: "fixture-acmg-workbook",
    version: "v1",
    sourceUri,
    citation,
    workbookDigest: digest(bytes),
    sheets,
    enforcePublishedCounts: false,
  });

  assert.deepEqual(bundle.quality.roleCounts, {
    rule_development: 7,
    authored_knowledge: 4,
    external_validation: 1,
    external_reanalysis: 1,
  });
  assert.equal(bundle.classificationRows[0]?.variantText, "NM_000001.1(GENE1):c.1A>G");
  assert.equal(bundle.classificationRows[0]?.identity.status, "unresolved");
  assert.deepEqual(bundle.classificationRows[0]?.referenceClassification, {
    raw: "Likley pathogenic",
    normalized: "likely_pathogenic",
    normalizationNotes: ["source_typo:Likley pathogenic"],
  });
  assert.deepEqual(bundle.quality.reportedConcordanceMismatches, [{
    rowId: "ST12_150 ClinGen varinats:3",
    actor: "o3_mini_high",
    reportedConcordant: true,
    computedConcordant: false,
  }]);
  assert.equal(bundle.sourceNotes.length, 4);
});

test("registration CAS-pins the workbook and bundle and records SQL validation in the ledger", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-acmg-workbook-"));
  const bytes = await fs.readFile(fixturePath);
  const workbookDigest = digest(bytes);
  try {
    const imported = await registerPublishedAcmgWorkbook(workspace, {
      datasetId: "fixture-acmg-workbook",
      version: "v1",
      sourceUri,
      citation,
      workbookBytes: bytes,
      expectedWorkbookDigest: workbookDigest,
      recordedAt: "2026-07-13T08:00:00Z",
      validationRunId: "fixture-acmg-workbook-validate",
      enforcePublishedCounts: false,
    });
    assert.equal(imported.registration.rawDigest, workbookDigest);
    assert.equal(imported.registration.validationRunId, "fixture-acmg-workbook-validate");
    assert.deepEqual(imported.validationRows.map((row) => [row.dataset_role, Number(row.row_count)]), [
      ["rule_development", 7],
      ["authored_knowledge", 4],
      ["external_validation", 1],
      ["external_reanalysis", 1],
    ]);
    assert.equal(
      imported.validationRows.reduce((sum, row) => sum + Number(row.concordance_mismatch_count), 0),
      1,
    );
    assert.ok(imported.registration.validationCasRefs.result?.startsWith("sha256:"));
    assert.ok(imported.registration.validationCasRefs.replay?.startsWith("sha256:"));

    const stored = await getPublishedAcmgBenchmarkRegistration(workspace, "fixture-acmg-workbook", "v1");
    assert.deepEqual(stored, imported.registration);
    const storedBundle = await getPublishedAcmgBenchmarkBundle(workspace, "fixture-acmg-workbook", "v1");
    assert.deepEqual(storedBundle, { registration: imported.registration, bundle: imported.bundle });
    const repeated = await registerPublishedAcmgWorkbook(workspace, {
      datasetId: "fixture-acmg-workbook",
      version: "v1",
      sourceUri,
      citation,
      workbookBytes: bytes,
      expectedWorkbookDigest: workbookDigest,
      recordedAt: "2026-07-14T08:00:00Z",
      enforcePublishedCounts: false,
    });
    assert.deepEqual(repeated.registration, imported.registration);
    assert.deepEqual(repeated.validationRows, []);

    const store = await openBioStore(workspace);
    try {
      await materializeBioEdgesAsOf(store.conn, "2026-07-15T00:00:00Z");
      const edges = await store.conn.all<{ predicate: string; object_id: string | null }>(
        `SELECT predicate, to_id AS object_id
         FROM bio_edges_as_of
         WHERE from_id = 'benchmark:fixture-acmg-workbook@v1'
         ORDER BY predicate, to_id`,
      );
      assert.deepEqual(edges.map((edge) => [edge.predicate, edge.object_id]), [
        ["produces", imported.registration.normalizedUri],
        ["uses_source", imported.registration.rawUri],
        ["validated_by", "run:fixture-acmg-workbook-validate"],
      ]);
    } finally {
      store.close();
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("registration fails closed on workbook digest drift", async () => {
  const bytes = await fs.readFile(fixturePath);
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-acmg-digest-"));
  try {
    await assert.rejects(
      () => registerPublishedAcmgWorkbook(workspace, {
        datasetId: "fixture-acmg-workbook",
        version: "v1",
        sourceUri,
        citation,
        workbookBytes: bytes,
        expectedWorkbookDigest: `sha256:${"0".repeat(64)}`,
        enforcePublishedCounts: false,
      }),
      (error: unknown) => error instanceof PublishedAcmgBenchmarkInputError && /workbook digest mismatch/.test(error.message),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("registration rejects empty or invalidly typed source containers", async () => {
  const bytes = await fs.readFile(fixturePath);
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-acmg-container-"));
  try {
    await assert.rejects(
      () => registerPublishedAcmgWorkbook(workspace, {
        datasetId: "fixture-acmg-workbook",
        version: "v1",
        sourceUri,
        citation,
        workbookBytes: bytes,
        expectedWorkbookDigest: digest(bytes),
        sourceContainer: {
          bytes: Buffer.from("container"),
          expectedDigest: digest(Buffer.from("container")),
          mediaType: "not-a-media-type",
        },
        enforcePublishedCounts: false,
      }),
      (error: unknown) => error instanceof PublishedAcmgBenchmarkInputError && /valid media type/.test(error.message),
    );
    await assert.rejects(
      () => registerPublishedAcmgWorkbook(workspace, {
        datasetId: "fixture-acmg-workbook",
        version: "v1",
        sourceUri,
        citation,
        workbookBytes: bytes,
        expectedWorkbookDigest: digest(bytes),
        sourceContainer: {
          bytes: Buffer.alloc(0),
          expectedDigest: digest(Buffer.alloc(0)),
          mediaType: "application/zip",
        },
        enforcePublishedCounts: false,
      }),
      (error: unknown) => error instanceof PublishedAcmgBenchmarkInputError && /must be non-empty/.test(error.message),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("archive import pins both the ZIP container and its single workbook", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-acmg-archive-"));
  const archivePath = join(workspace, "tables.zip");
  const workbookBytes = await fs.readFile(fixturePath);
  const archiveBytes = Buffer.from(zipSync({ "tables.xlsx": workbookBytes }));
  await fs.writeFile(archivePath, archiveBytes);
  try {
    const imported = await registerPublishedAcmgWorkbookArchiveFile(workspace, {
      datasetId: "fixture-acmg-archive",
      version: "v1",
      sourceUri,
      citation,
      archivePath,
      expectedArchiveDigest: digest(archiveBytes),
      expectedWorkbookDigest: digest(workbookBytes),
      enforcePublishedCounts: false,
    });
    assert.equal(imported.registration.containerDigest, digest(archiveBytes));
    assert.equal(imported.registration.rawDigest, digest(workbookBytes));
    assert.ok(imported.registration.containerUri?.startsWith("cas:sha256:"));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
