import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbenchApi } from "../src/api/app.js";
import { loadRecordedGroundingRuntime } from "../src/recorded-grounding.js";
import { localMonarchFixtureRuntime } from "../src/monarch-host.js";
import { localCandidateVariantSearchRuntime } from "../src/candidate-variant-search.js";
import { startVepFixture } from "./vep-fixture.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureRoot = join(repoRoot, "examples", "clinical-genomics");

async function appFixture() {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-api-"));
  await fs.cp(fixtureRoot, workspace, {
    recursive: true,
    filter: (source) => relative(fixtureRoot, source).split(sep)[0] !== ".pi",
  });
  const vep = await startVepFixture();
  return {
    app: createWorkbenchApi({
      clinicalWorkspace: workspace,
      grounding: await loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json")),
      hypotheses: localMonarchFixtureRuntime(workspace),
      variantSearch: localCandidateVariantSearchRuntime(workspace),
      vep: vep.runtime,
      clock: () => "2026-07-05T12:00:00Z",
    }),
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

test("HTTP creates an analysis and reads its packet back from CAS", async () => {
  const fixture = await appFixture();
  try {
    const app = fixture.app;
    const created = await app.request("/v1/clinical-analyses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "CASE-RD-001" }),
  });
    assert.equal(created.status, 201);
    const result = await created.json() as {
    analysisId: string;
    packetDigest: string;
    packet: { caseId: string; summary: { directCandidates: number } };
    };
    assert.equal(result.packet.caseId, "CASE-RD-001");
    assert.equal(result.packet.summary.directCandidates, 1);
    assert.match(result.packetDigest, /^sha256:[0-9a-f]{64}$/);

    const fetched = await app.request(`/v1/clinical-analyses/${result.analysisId}`);
    assert.equal(fetched.status, 200);
    const recorded = await fetched.json() as typeof result;
    assert.equal(recorded.packetDigest, result.packetDigest);
    assert.deepEqual(recorded.packet, result.packet);

    const missing = await app.request("/v1/clinical-analyses/does-not-exist");
    assert.equal(missing.status, 404);
  } finally {
    await fixture.close();
  }
});
