import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fsCasStore, openBioStore, recordArtifactReference } from "pi-bio-agent";

const packet = {
  schema: "pi-bio.workbench.evidence_packet.v1",
  analysisId: "analysis-browser-proof",
  caseId: "CASE-RD-001",
  generatedAt: "2026-07-12T12:00:00.000Z",
  stages: {},
  lanes: {
    direct: {
      operationId: "case.direct",
      runId: "run-direct",
      rows: [{
        case_id: "CASE-RD-001",
        lane: "direct",
        evidence_key: "variant:GRCh38:1:100:A:T",
        gene: "GENE1",
        disease_label: "Example condition",
        variant_key: "GRCh38:1:100:A:T",
        evidence_status: "candidate_needs_review",
        review_kind: "adjudicate_candidate",
        review_target: "variant:GRCh38:1:100:A:T",
      }],
    },
    inverted: {
      operationId: "case.inverted",
      runId: "run-inverted",
      rows: [{
        case_id: "CASE-RD-001",
        lane: "inverted",
        evidence_key: "hypothesis:GENE2:no-supporting-variant",
        gene: "GENE2",
        disease_label: "Second condition",
        variant_key: null,
        evidence_status: "hypothesis_without_supporting_variant",
        review_kind: "review_missing_genotype_support",
        review_target: "hypothesis:GENE2",
      }],
    },
  },
  grounding: {},
  summary: {
    directCandidates: 1,
    directAbstentions: 1,
    phenotypeHypotheses: 2,
    resolvedCandidateGenes: 2,
    unresolvedCandidateGenes: 0,
    searchedCandidateGenes: 2,
    unsearchedCandidateGenes: 0,
    selectedAlleles: 1,
    invertedSupportedHypotheses: 0,
    invertedGaps: 1,
    invertedUnsearched: 0,
    conflicts: 0,
    reanalysisSignals: 0,
    reviewQueue: [{
      kind: "adjudicate_candidate",
      target: "GRCh38:1:100:A:T",
      reason: "Candidate requires evidence review.",
    }],
    kernelScope: "browser fixture",
  },
  provenance: { runIds: ["run-direct", "run-inverted"] },
};

const criterion = (raw: string, code: string, strength = "default") => ({
  raw,
  code,
  strength,
  applied: true,
  sourceFlag: "none",
  parseStatus: "parsed",
});

const publishedVariant = {
  benchmark: {
    datasetId: "ma-2025-acmg-llm",
    version: "adz4172-tables-s1-s13",
    citation: "Ma et al., Science Translational Medicine (2026)",
    sourceUri: "https://www.science.org/doi/10.1126/scitranslmed.adz4172",
    normalizedDigest: `sha256:${"1".repeat(64)}`,
    recordedAt: "2026-07-13T10:00:00.000Z",
    roleCounts: { rule_development: 1000, authored_knowledge: 180, external_validation: 150, external_reanalysis: 150 },
  },
  row: {
    rowId: "ST12_150 ClinGen varinats:39",
    datasetRole: "external_validation",
    sourceRow: 39,
    sheet: "ST12_150 ClinGen varinats",
    genes: ["FOXN1"],
    variantText: "NM_001369369.1(FOXN1):c.880G>A (p.Val294Ile)",
    sourceClassification: { raw: "Pathogenic", normalized: "pathogenic", normalizationNotes: [] },
    referenceClassification: { raw: "Likely pathogenic", normalized: "likely_pathogenic", normalizationNotes: [] },
    literatureIndependentCriteriaRaw: "PM2_Supporting, PP3",
    literatureIndependentCriteria: [criterion("PM2_Supporting", "PM2", "supporting"), criterion("PP3", "PP3")],
    humanCriteriaRaw: "PS3, PM3, PP1, PP4",
    humanCriteria: [criterion("PS3", "PS3"), criterion("PM3", "PM3"), criterion("PP1", "PP1"), criterion("PP4", "PP4")],
    sourceSubmissionSummary: "Expert panel reviewed germline classification",
    publicationCount: 2,
    modelAssessments: {
      deepseekR1: {
        criteriaRaw: "PS3, PM3, PP1, PP4",
        criteria: [criterion("PS3", "PS3"), criterion("PM3", "PM3"), criterion("PP1", "PP1"), criterion("PP4", "PP4")],
        classification: { raw: "Likely pathogenic", normalized: "likely_pathogenic", normalizationNotes: [] },
        reportedConcordant: true,
        computedConcordant: true,
        concordanceConsistent: true,
      },
      o3MiniHigh: {
        criteriaRaw: "PS3, PM3, PP1, PP4",
        criteria: [criterion("PS3", "PS3"), criterion("PM3", "PM3"), criterion("PP1", "PP1"), criterion("PP4", "PP4")],
        classification: { raw: "Likely pathogenic", normalized: "likely_pathogenic", normalizationNotes: [] },
        reportedConcordant: true,
        computedConcordant: true,
        concordanceConsistent: true,
      },
    },
    deepseekConcordant: true,
    o3MiniHighConcordant: true,
    unparsedCriterionCount: 0,
  },
  resolutionUri: `cas:sha256:${"2".repeat(64)}`,
  resolution: {
    schema: "pi-bio.workbench.published_variant_resolution.v1",
    datasetId: "ma-2025-acmg-llm",
    version: "adz4172-tables-s1-s13",
    rowId: "ST12_150 ClinGen varinats:39",
    sourceVariantText: "NM_001369369.1(FOXN1):c.880G>A (p.Val294Ile)",
    genes: ["FOXN1"],
    transcriptHgvs: "NM_001369369.1:c.880G>A",
    transcriptSpdi: "NM_001369369.1:989:G:A",
    rsids: ["1406320425"],
    genomicLocation: { assembly: "GRCh38", chromosome: "17", position1Based: 28530798, ref: "G", alt: "A", canonicalSpdi: "NC_000017.11:28530797:G:A" },
    clinvar: {
      uid: "3367209",
      accession: "VCV003367209",
      accessionVersion: "VCV003367209.3",
      title: "NM_001369369.1(FOXN1):c.880G>A (p.Val294Ile)",
      canonicalSpdi: "NC_000017.11:28530797:G:A",
      classification: "Pathogenic",
      reviewStatus: "reviewed by expert panel",
      lastEvaluated: "2024/07/29 00:00",
      traits: [{ name: "T-cell immunodeficiency, congenital alopecia, and nail dystrophy", xrefs: [{ source: "MONDO", id: "MONDO:0011132" }] }],
    },
    sourceSnapshots: [
      { sourceId: "ncbi_variation_hgvs", uri: "https://api.ncbi.nlm.nih.gov/variation/v0/hgvs/example/contextuals", retrievedAt: "2026-07-13T10:00:00.000Z", mediaType: "application/json", digest: `sha256:${"3".repeat(64)}`, casUri: `cas:sha256:${"3".repeat(64)}`, sizeBytes: 512, runId: "published-variant-source-hgvs", receiptDigest: `sha256:${"5".repeat(64)}` },
      { sourceId: "ncbi_clinvar_summary", uri: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", retrievedAt: "2026-07-13T10:00:00.000Z", mediaType: "application/json", digest: `sha256:${"4".repeat(64)}`, casUri: `cas:sha256:${"4".repeat(64)}`, sizeBytes: 1024, runId: "published-variant-source-clinvar", receiptDigest: `sha256:${"6".repeat(64)}` },
    ],
  },
};

async function usePublishedVariant(page: import("@playwright/test").Page) {
  await page.route(/\/v1\/published-variants\?(?:.*)$/, async (route) => {
    const row = publishedVariant.row;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        benchmark: publishedVariant.benchmark,
        featuredRowId: row.rowId,
        totalCount: 1,
        offset: 0,
        limit: 50,
        rows: [{
          rowId: row.rowId,
          datasetRole: row.datasetRole,
          sourceRow: row.sourceRow,
          genes: row.genes,
          variantText: row.variantText,
          sourceClassification: row.sourceClassification,
          referenceClassification: row.referenceClassification,
          literatureIndependentCriteria: row.literatureIndependentCriteria,
          humanCriteria: row.humanCriteria,
          deepseekConcordant: row.deepseekConcordant,
          o3MiniHighConcordant: row.o3MiniHighConcordant,
          unparsedCriterionCount: row.unparsedCriterionCount,
        }],
      }),
    });
  });
  await page.route(`**/v1/published-variants/${encodeURIComponent(publishedVariant.row.rowId)}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(publishedVariant) });
  });
  await page.route(/\/v1\/artifacts\?(?:.*)$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ artifacts: [
        {
          casUri: publishedVariant.resolutionUri,
          digest: publishedVariant.resolutionUri.slice("cas:".length),
          mediaType: "application/json",
          semanticRole: "resolved_variant_identity",
          sizeBytes: 2048,
          sourceNode: `variant-resolution:${publishedVariant.benchmark.datasetId}@${publishedVariant.benchmark.version}:${publishedVariant.row.rowId}`,
          relation: "produces",
          recordedAt: "2026-07-13T10:00:00.000Z",
          producerRun: null,
          attrs: {},
          contentUrl: `/v1/artifacts/${"2".repeat(64)}/content`,
        },
        {
          casUri: `cas:sha256:${"9".repeat(64)}`,
          digest: `sha256:${"9".repeat(64)}`,
          mediaType: "application/json",
          semanticRole: "unrelated",
          sizeBytes: 16,
          sourceNode: "analysis:unrelated",
          relation: "produces",
          recordedAt: "2026-07-13T09:00:00.000Z",
          producerRun: null,
          attrs: {},
          contentUrl: `/v1/artifacts/${"9".repeat(64)}/content`,
        },
      ] }),
    });
  });
}

async function useRecordedPacket(page: import("@playwright/test").Page) {
  const reviewId = "c".repeat(64);
  let review = {
    ...packet.summary.reviewQueue[0],
    reviewId,
    status: "open",
    note: null as string | null,
    updatedAt: null as string | null,
  };
  const recorded = {
    analysisId: packet.analysisId,
    packet,
    packetDigest: `sha256:${"a".repeat(64)}`,
    packetUri: `cas:sha256:${"a".repeat(64)}`,
  };
  const summary = {
    analysisId: packet.analysisId,
    caseId: packet.caseId,
    packetDigest: recorded.packetDigest,
    packetUri: recorded.packetUri,
    generatedAt: packet.generatedAt,
    recordedAt: packet.generatedAt,
    reviewItems: packet.summary.reviewQueue.length,
    directCandidates: packet.summary.directCandidates,
    directAbstentions: packet.summary.directAbstentions,
    conflicts: packet.summary.conflicts,
    reanalysisSignals: packet.summary.reanalysisSignals,
  };
  await page.route(/\/v1\/clinical-analyses(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ analyses: [summary] }) });
      return;
    }
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        ...recorded,
        workflow: { replayDigest: `sha256:${"b".repeat(64)}`, executedSteps: 8, reusedSteps: 0 },
      }),
    });
  });
  await page.route(`**/v1/clinical-analyses/${packet.analysisId}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(recorded) });
  });
  await page.route(`**/v1/clinical-analyses/${packet.analysisId}/reviews`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        analysisId: packet.analysisId,
        caseId: packet.caseId,
        packetDigest: recorded.packetDigest,
        reviews: [review],
      }) });
      return;
    }
    return route.continue();
  });
  await page.route(`**/v1/clinical-analyses/${packet.analysisId}/reviews/${reviewId}`, async (route) => {
    const body = route.request().postDataJSON() as { status: string; note?: string };
    review = { ...review, status: body.status, note: body.note ?? null, updatedAt: "2026-07-12T12:05:00.000Z" };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      analysisId: packet.analysisId,
      caseId: packet.caseId,
      packetDigest: recorded.packetDigest,
      reviews: [review],
    }) });
  });
  await page.route(/\/v1\/clinical-reanalysis-queue(?:\?.*)?$/, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      cases: [{
        ...summary,
        groundingId: "grounding:analysis-browser-proof",
        runIds: packet.provenance.runIds,
        state: "evidence_gap",
        reasons: ["1 recorded evidence gap remains unresolved."],
        changes: [],
        openReviewItems: review.status === "acknowledged" ? 0 : 1,
        needsFollowUpItems: review.status === "needs_follow_up" ? 1 : 0,
        evidenceGaps: 1,
      }],
    }) });
  });
}

test("real Pi session control and evidence rendering compose in the browser", async ({ page }, testInfo) => {
  await useRecordedPacket(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveTitle("pi-bio workbench");
  await expect(page.getByText("Ready · pi")).toBeVisible();

  await page.getByRole("button", { name: "New Pi session" }).click();
  await expect(page.locator("#message")).toBeEnabled();
  await expect(page.locator("#session-facts")).toContainText("idle");
  await expect(page.locator("#activity-list")).toContainText("Session opened");

  await page.locator("#message").fill("/");
  await expect(page.locator("#command-menu")).toBeVisible();
  await expect(page.locator("#command-menu")).toContainText("/rename");
  await expect(page.locator("#command-menu")).toContainText("/skill:pi-bio-agent");
  await page.locator("#message").fill("/rename Clinical browser review");
  await page.locator("#send").click();
  await expect(page.locator("#session-list")).toContainText("Clinical browser review");
  await expect(page.locator("#activity-list")).toContainText("Renamed to Clinical browser review");

  if (testInfo.project.name === "chromium") {
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.locator("#session-name").fill("Fixture evidence review");
    await page.locator("#rename-form").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#session-list")).toContainText("Fixture evidence review");
  }

  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.locator("#analysis-steps")).toContainText("Ground narrative to reviewed HPO assertions");
  await expect(page.locator("#analysis-steps")).toContainText("Commit packet, receipts, replay, and graph links");
  await page.getByRole("button", { name: "Run recorded workup" }).click();
  await expect(page.locator("#analysis-status")).toContainText("analysis-browser-proof");
  await expect(page.locator("#analysis-status")).toContainText("8 executed");
  await expect(page.locator("#analysis-content")).toContainText("Direct candidates");
  await expect(page.locator("#analysis-content")).toContainText("GRCh38:1:100:A:T");
  await expect(page.locator("#analysis-content")).toContainText("Recorded workflow");
  await expect(page.locator("#analysis-content details")).toContainText("Evidence packet JSON");
  await expect(page.locator("#analysis-history")).toContainText("analysis-browser-proof");
  await page.getByRole("button", { name: "Inspect", exact: true }).first().click();
  await expect(page.locator("#analysis-content")).toContainText("Evidence focus");
  await page.locator(".review-disposition").selectOption("needs_follow_up");
  await page.locator(".review-note").fill("Obtain a declared frequency source.");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.locator(".review-note")).toHaveValue("Obtain a declared frequency source.");

  await page.getByRole("button", { name: "Ask Pi" }).click();
  await expect(page.getByRole("button", { name: "Agent" })).toHaveClass(/active/);
  await expect(page.locator("#message")).toHaveValue(/run-direct, run-inverted/);
  await expect(page.locator("#message")).toHaveValue(/identifiers are pointers, not the fact source/);

  await page.getByRole("button", { name: "Close active session" }).click();
  await expect(page.locator("#message")).toBeDisabled();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  expect(browserErrors).toEqual([]);
});

test("published variants keep workbook decisions separate from pinned current sources", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one source-resolution browser proof is sufficient");
  await usePublishedVariant(page);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "New Pi session" }).click();
  await page.getByRole("button", { name: "Variants", exact: true }).click();
  await expect(page.locator("#variant-status")).toContainText("2 pinned source responses");
  await expect(page.locator("#variant-detail")).toContainText("FOXN1");
  await expect(page.locator("#variant-detail")).toContainText("NM_001369369.1(FOXN1):c.880G>A");
  await expect(page.locator(".classification-comparison")).toContainText("Pathogenic");
  await expect(page.locator(".classification-comparison")).toContainText("Likely pathogenic");
  await expect(page.locator(".source-resolution")).toContainText("VCV003367209.3");
  await expect(page.locator(".source-resolution")).toContainText("rs1406320425");
  await expect(page.locator(".source-resolution")).toContainText(`sha256:${"3".repeat(64)}`);
  await expect(page.locator(".criterion-groups")).toContainText("Literature-independent");
  await expect(page.locator(".criterion-groups")).toContainText("Human literature review");

  await page.getByRole("button", { name: "Ask Pi" }).click();
  await expect(page.getByRole("button", { name: "Agent" })).toHaveClass(/active/);
  await expect(page.locator("#message")).toHaveValue(/workbook and current source classifications as separate time-stamped observations/);
  await expect(page.locator("#message")).toHaveValue(/sha256:3333333333333333333333333333333333333333333333333333333333333333/);

  await page.getByRole("button", { name: "Artifacts" }).click();
  await expect(page.locator("#artifact-context")).toContainText(publishedVariant.row.rowId);
  await expect(page.locator(".artifact-card")).toHaveCount(1);
  await expect(page.locator(".artifact-card")).toContainText("resolved_variant_identity");
  await expect(page.locator("#artifact-gallery")).not.toContainText("unrelated");
  expect(browserErrors).toEqual([]);
});

test("a real clinical browser run is recoverable from CAS", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one real durable analysis is sufficient");
  test.setTimeout(45_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/v1/clinical-analyses") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run recorded workup" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const created = await response.json() as {
    analysisId: string;
    packetDigest: string;
    packetUri: string;
    packet: { provenance: { runIds: string[] } };
    workflow: { replayDigest: string };
  };
  expect(created.packetUri).toBe(`cas:${created.packetDigest}`);
  expect(created.workflow.replayDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(page.locator("#analysis-status")).toContainText(created.analysisId);
  for (const runId of created.packet.provenance.runIds) {
    await expect(page.locator("#analysis-content")).toContainText(runId);
  }

  const recordedResponse = await page.request.get(`/v1/clinical-analyses/${encodeURIComponent(created.analysisId)}`);
  expect(recordedResponse.status()).toBe(200);
  const recorded = await recordedResponse.json() as { packetDigest: string; packet: unknown };
  expect(recorded.packetDigest).toBe(created.packetDigest);
  expect(recorded.packet).toEqual(created.packet);
});

test("the reanalysis queue opens a selected recorded evidence packet", async ({ page }) => {
  await useRecordedPacket(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.locator("#case-id").fill("CASE-OTHER");
  await page.getByRole("button", { name: "Reanalysis", exact: true }).click();
  await expect(page.locator("#reanalysis-content")).toContainText("CASE-RD-001");
  await expect(page.locator("#reanalysis-content")).toContainText("Evidence gap");
  await page.getByRole("button", { name: "Open evidence", exact: true }).click();
  await expect(page.getByRole("button", { name: "Evidence", exact: true })).toHaveClass(/active/);
  await expect(page.locator("#case-id")).toHaveValue("CASE-RD-001");
  await expect(page.locator("#analysis-content")).toContainText("Recorded workflow");
  await expect(page.locator("#analysis-content")).toContainText("GRCh38:1:100:A:T");
});

test("the artifact addon renders a real CAS-backed figure", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "one real artifact render is sufficient");
  const workspace = resolve("examples/clinical-genomics");
  const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='640' height='320'><rect width='640' height='320' fill='white'/><path d='M60 260 L180 120 L300 205 L420 70 L570 145' stroke='#176b50' stroke-width='8' fill='none'/><circle cx='420' cy='70' r='10' fill='#2b5fab'/></svg>");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const cas = fsCasStore(resolve(workspace, ".pi/bio-agent/cas"));
  await cas.put({ algorithm: "sha256", digest }, bytes);
  const store = await openBioStore(workspace);
  try {
    await recordArtifactReference(store.conn, {
      artifact: { digest: `sha256:${digest}`, mediaType: "image/svg+xml", semanticRole: "figure", sizeBytes: bytes.length },
      subjectId: "run:browser-plot-proof",
      predicate: "produces",
      recordedAt: "2026-07-12T12:30:00Z",
      attrs: { plotting_system: "browser-fixture", caption: "CAS-backed plot proof" },
    });
  } finally {
    store.close();
  }

  await page.goto("/");
  await page.getByRole("button", { name: "Artifacts" }).click();
  const card = page.locator(".artifact-card").filter({ hasText: "run:browser-plot-proof" });
  await expect(card).toContainText("figure");
  await expect(card.locator("img")).toBeVisible();
  const dimensions = await card.locator("img").evaluate((image) => ({
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  expect(dimensions.naturalWidth).toBe(640);
  expect(dimensions.naturalHeight).toBe(320);
});

test("the workbench remains coherent on a mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile geometry assertion");
  await page.goto("/");
  await expect(page.getByText("pi-bio workbench").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "New Pi session" })).toBeVisible();
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
    topbar: document.querySelector(".topbar")?.getBoundingClientRect(),
    sessions: document.querySelector(".session-pane")?.getBoundingClientRect(),
    workspace: document.querySelector(".workspace")?.getBoundingClientRect(),
  }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.sessions?.bottom).toBeLessThanOrEqual(geometry.workspace?.top ?? 0);
});
