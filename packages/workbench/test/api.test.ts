import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createClinicalReanalysisWorkbenchAddon,
  createClinicalWorkbenchAddon,
  createWorkbenchApi,
} from "../src/api/app.js";
import { loadRecordedGroundingRuntime } from "../src/recorded-grounding.js";
import { localMonarchFixtureRuntime } from "../src/monarch-host.js";
import { localCandidateVariantSearchRuntime } from "../src/candidate-variant-search.js";
import { startVepFixture } from "./vep-fixture.js";
import { fsCasStore, openBioStore, recordArtifactReference } from "pi-bio-agent";
import { createArtifactWorkbenchAddon } from "../src/artifact-addon.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function appFixture() {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-api-"));
  await fs.cp(fixtureRoot, workspace, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  const vep = await startVepFixture();
  const clinicalOptions = {
    clinicalWorkspace: workspace,
    grounding: await loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json")),
    hypotheses: localMonarchFixtureRuntime(workspace),
    variantSearch: localCandidateVariantSearchRuntime(workspace),
    vep: vep.runtime,
    clock: () => "2026-07-05T12:00:00Z",
  };
  return {
    app: createWorkbenchApi({ addons: [
      createClinicalWorkbenchAddon(clinicalOptions),
      createClinicalReanalysisWorkbenchAddon(clinicalOptions),
      createArtifactWorkbenchAddon(workspace),
    ] }),
    workspace,
    close: vep.close,
  };
}

test("OpenAPI and runtime validation share the clinical analysis schemas", async () => {
  const fixture = await appFixture();
  try {
    const app = fixture.app;
    const openApiResponse = await app.request("/openapi.json");
    assert.equal(openApiResponse.status, 200);
    const document = await openApiResponse.json() as {
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
    };
    assert.ok(document.paths["/v1/clinical-analyses"]);
    assert.ok(document.paths["/v1/clinical-analyses/{analysisId}"]);
    assert.ok(document.paths["/v1/clinical-analyses/{analysisId}/reviews"]);
    assert.ok(document.paths["/v1/clinical-analyses/{analysisId}/reviews/{reviewId}"]);
    assert.ok(document.paths["/v1/clinical-reanalysis-queue"]);
    assert.ok(document.paths["/v1/clinical-case-assets/{digest}"]);
    assert.ok(document.paths["/v1/clinical-cases/{caseId}/revisions"]);
    assert.ok(document.paths["/v1/clinical-cases/{caseId}/revisions/{revisionId}"]);
    assert.ok(document.paths["/v1/artifacts"]);
    assert.ok(document.paths["/v1/artifacts/{digest}/content"]);
    assert.ok(document.components.schemas.EvidencePacket);
    assert.equal(JSON.stringify(document).includes("exampleDir"), false, "host workspace paths are not request data");
    assert.equal(JSON.stringify(document).includes("storePath"), false, "host store paths are not response data");
    assert.equal(JSON.stringify(document).includes("analysisDbPath"), false, "host analysis paths are not response data");

    const invalid = await app.request("/v1/clinical-analyses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "", exampleDir: "/tmp/host-path" }),
  });
    assert.equal(invalid.status, 400);

    const invalidId = await app.request("/v1/clinical-analyses/bad$id");
    assert.equal(invalidId.status, 400);
  } finally {
    await fixture.close();
  }
});

test("HTTP stages content-addressed assets and registers immutable family case revisions", async () => {
  const fixture = await appFixture();
  try {
    const narrative = Buffer.from("The proband has developmental delay and hypotonia.");
    const narrativeDigest = createHash("sha256").update(narrative).digest("hex");
    const staged = await fixture.app.request(`/v1/clinical-case-assets/${narrativeDigest}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: narrative,
    });
    assert.equal(staged.status, 201);
    assert.deepEqual(await staged.json(), {
      digest: `sha256:${narrativeDigest}`,
      uri: `cas:sha256:${narrativeDigest}`,
      sizeBytes: narrative.length,
    });

    const mismatch = await fixture.app.request(`/v1/clinical-case-assets/${"0".repeat(64)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: narrative,
    });
    assert.equal(mismatch.status, 400);

    const registered = await fixture.app.request("/v1/clinical-cases/family-api/revisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revisionId: "r-1",
        indexMemberIds: ["proband"],
        members: [
          { memberId: "proband", role: "proband", affectedStatus: "affected", sex: "female" },
          { memberId: "mother", role: "mother", affectedStatus: "unaffected", sex: "female" },
        ],
        relationships: [{ fromMemberId: "mother", predicate: "parent_of", toMemberId: "proband" }],
        assets: [{
          assetId: "narrative",
          kind: "clinical_narrative",
          mediaType: "text/plain",
          digest: `sha256:${narrativeDigest}`,
          memberIds: ["proband"],
        }],
      }),
    });
    assert.equal(registered.status, 201);
    const revision = await registered.json() as {
      caseId: string;
      revisionId: string;
      members: Array<{ memberId: string }>;
      assets: Array<{ digest: string; sizeBytes: number }>;
    };
    assert.equal(revision.caseId, "family-api");
    assert.equal(revision.revisionId, "r-1");
    assert.equal(revision.members.length, 2);
    assert.deepEqual(revision.assets.map((asset) => [asset.digest, asset.sizeBytes]), [[`sha256:${narrativeDigest}`, narrative.length]]);

    const fetched = await fixture.app.request("/v1/clinical-cases/family-api/revisions/r-1");
    assert.equal(fetched.status, 200);
    assert.deepEqual(await fetched.json(), revision);
    const listed = await fixture.app.request("/v1/clinical-cases/family-api/revisions?limit=10");
    assert.equal(listed.status, 200);
    const history = await listed.json() as { revisions: Array<{ revisionId: string; parentRevisionId: string | null }> };
    assert.deepEqual(history.revisions.map((item) => [item.revisionId, item.parentRevisionId]), [["r-1", null]]);
  } finally {
    await fixture.close();
  }
});

test("artifact addon projects ledger references and serves verified CAS bytes", async () => {
  const fixture = await appFixture();
  try {
    const bytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><rect width='120' height='60' fill='white'/><path d='M10 50 L45 20 L80 35 L110 10' stroke='#176b50' fill='none'/></svg>");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const cas = fsCasStore(join(fixture.workspace, ".pi", "bio-agent", "cas"));
    await cas.put({ algorithm: "sha256", digest }, bytes);
    const store = await openBioStore(fixture.workspace);
    try {
      await recordArtifactReference(store.conn, {
        artifact: { digest: `sha256:${digest}`, mediaType: "image/svg+xml", semanticRole: "figure", sizeBytes: bytes.length },
        subjectId: "run:artifact-api-proof",
        predicate: "produces",
        recordedAt: "2026-07-05T12:00:00Z",
        attrs: { plotting_system: "fixture" },
      });
    } finally {
      store.close();
    }

    const list = await fixture.app.request("/v1/artifacts");
    assert.equal(list.status, 200);
    const body = await list.json() as { artifacts: Array<{ digest: string; mediaType: string; sourceNode: string; contentUrl: string }> };
    const artifact = body.artifacts.find((item) => item.digest === `sha256:${digest}`);
    assert.equal(artifact?.mediaType, "image/svg+xml");
    assert.equal(artifact?.sourceNode, "run:artifact-api-proof");
    assert.equal(artifact?.contentUrl, `/v1/artifacts/${digest}/content`);

    const content = await fixture.app.request(artifact!.contentUrl);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get("content-type"), "image/svg+xml");
    assert.match(content.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);

    const invalid = await fixture.app.request("/v1/artifacts/not-a-digest/content");
    assert.equal(invalid.status, 400);
  } finally {
    await fixture.close();
  }
});

test("HTTP projects recorded analyses, durable review state, and a transparent reanalysis queue", async () => {
  const fixture = await appFixture();
  try {
    const app = fixture.app;
    const created = await app.request("/v1/clinical-analyses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "CASE-RD-001", analysisId: "api-review-state" }),
  });
    assert.equal(created.status, 201);
    const result = await created.json() as {
    analysisId: string;
    packetDigest: string;
    packetUri: string;
    packet: {
      caseId: string;
      generatedAt: string;
      grounding: { groundingId: string };
      provenance: { runIds: string[] };
      summary: {
        directCandidates: number;
        directAbstentions: number;
        conflicts: number;
        reanalysisSignals: number;
        reviewQueue: Array<{ kind: string; target: string; reason: string }>;
      };
    };
    };
    assert.equal(result.packet.caseId, "CASE-RD-001");
    assert.equal(result.analysisId, "api-review-state");
    assert.equal(result.packet.summary.directCandidates, 1);
    assert.match(result.packetDigest, /^sha256:[0-9a-f]{64}$/);

    const fetched = await app.request(`/v1/clinical-analyses/${result.analysisId}`);
    assert.equal(fetched.status, 200);
    const recorded = await fetched.json() as typeof result;
    assert.equal(recorded.packetDigest, result.packetDigest);
    assert.deepEqual(recorded.packet, result.packet);

    const history = await app.request("/v1/clinical-analyses?caseId=CASE-RD-001&limit=10");
    assert.equal(history.status, 200);
    const listed = await history.json() as { analyses: Array<{
      analysisId: string;
      caseId: string;
      packetDigest: string;
      packetUri: string;
      generatedAt: string;
      recordedAt: string;
      reviewItems: number;
      directCandidates: number;
      directAbstentions: number;
      conflicts: number;
      reanalysisSignals: number;
    }> };
    assert.equal(listed.analyses.length, 1);
    assert.deepEqual({ ...listed.analyses[0], recordedAt: undefined }, {
      analysisId: result.analysisId,
      caseId: "CASE-RD-001",
      packetDigest: result.packetDigest,
      packetUri: result.packetUri,
      generatedAt: result.packet.generatedAt,
      reviewItems: result.packet.summary.reviewQueue.length,
      directCandidates: 1,
      directAbstentions: 1,
      conflicts: 2,
      reanalysisSignals: 1,
      recordedAt: undefined,
    });
    assert.match(listed.analyses[0]!.recordedAt, /^2026-07-05T12:00:00(?:\.000)?Z$/);

    const reviewsResponse = await app.request(`/v1/clinical-analyses/${result.analysisId}/reviews`);
    assert.equal(reviewsResponse.status, 200);
    const reviewQueue = await reviewsResponse.json() as {
      reviews: Array<{ reviewId: string; kind: string; status: string; note: string | null }>;
    };
    const frequencyReview = reviewQueue.reviews.find((item) => item.kind === "resolve_frequency");
    assert.ok(frequencyReview);
    assert.equal(frequencyReview.status, "open");

    const revisedResponse = await app.request(`/v1/clinical-analyses/${result.analysisId}/reviews/${frequencyReview.reviewId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "needs_follow_up", note: "Obtain a declared frequency source." }),
    });
    assert.equal(revisedResponse.status, 200);
    const revised = await revisedResponse.json() as typeof reviewQueue;
    const revisedFrequencyReview = revised.reviews.find((item) => item.reviewId === frequencyReview.reviewId);
    assert.deepEqual(revisedFrequencyReview && {
      reviewId: revisedFrequencyReview.reviewId,
      kind: revisedFrequencyReview.kind,
      status: revisedFrequencyReview.status,
      note: revisedFrequencyReview.note,
    }, {
      reviewId: frequencyReview.reviewId,
      kind: "resolve_frequency",
      status: "needs_follow_up",
      note: "Obtain a declared frequency source.",
    });

    const reanalysis = await app.request("/v1/clinical-reanalysis-queue?limit=10");
    assert.equal(reanalysis.status, 200);
    const reanalysisQueue = await reanalysis.json() as {
      cases: Array<{
        analysisId: string;
        groundingId: string;
        runIds: string[];
        state: string;
        needsFollowUpItems: number;
        reasons: string[];
      }>;
    };
    assert.deepEqual(reanalysisQueue.cases.map((item) => ({
      analysisId: item.analysisId,
      groundingId: item.groundingId,
      runIds: item.runIds,
      state: item.state,
      needsFollowUpItems: item.needsFollowUpItems,
    })), [{
      analysisId: result.analysisId,
      groundingId: result.packet.grounding.groundingId,
      runIds: result.packet.provenance.runIds,
      state: "needs_follow_up",
      needsFollowUpItems: 1,
    }]);
    assert.match(reanalysisQueue.cases[0]!.reasons.join(" "), /marked for follow-up/);

    const invalidReview = await app.request(`/v1/clinical-analyses/${result.analysisId}/reviews/${"a".repeat(64)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    assert.equal(invalidReview.status, 400);

    const missing = await app.request("/v1/clinical-analyses/does-not-exist");
    assert.equal(missing.status, 404);
  } finally {
    await fixture.close();
  }
});
