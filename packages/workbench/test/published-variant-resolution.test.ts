import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { materializeBioEdgesAsOf, openBioStore } from "pi-bio-agent";
import { createWorkbenchApi } from "../src/api/app.js";
import { registerPublishedAcmgWorkbook } from "../src/published-acmg-benchmark.js";
import { createPublishedVariantsWorkbenchAddon } from "../src/published-variants-addon.js";
import {
  getPublishedVariantResolution,
  resolvePublishedVariantWithNcbi,
  type PublishedVariantFetch,
} from "../src/published-variant-resolution.js";

const fixturePath = resolve("test/fixtures/published-acmg-workbook.xlsx");

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
}

function jsonResponse(value: unknown) {
  const body = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null },
    text: async () => body,
  };
}

test("a published HGVS row resolves through pinned NCBI source snapshots", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-published-variant-"));
  const workbookBytes = await fs.readFile(fixturePath);
  const calls: string[] = [];
  const sourceFetch: PublishedVariantFetch = async (uri) => {
    calls.push(uri);
    if (uri.includes("/hgvs/")) return jsonResponse({
      data: { spdis: [{ seq_id: "NM_000001.1", position: 100, deleted_sequence: "A", inserted_sequence: "G" }], input_hgvs_validity: "valid" },
    });
    if (uri.includes("/spdi/")) return jsonResponse({ data: { rsids: [123456] } });
    if (uri.includes("esearch.fcgi")) return jsonResponse({ esearchresult: { count: "1", idlist: ["777"] } });
    if (uri.includes("esummary.fcgi")) return jsonResponse({
      result: {
        uids: ["777"],
        "777": {
          uid: "777",
          accession: "VCV000000777",
          accession_version: "VCV000000777.2",
          title: "NM_000001.1(GENE1):c.1A>G",
          variation_set: [{
            canonical_spdi: "NC_000001.11:99:A:G",
            variation_loc: [{ status: "current", assembly_name: "GRCh38", chr: "1", start: "100", stop: "100" }],
          }],
          germline_classification: {
            description: "Likely pathogenic",
            review_status: "reviewed by expert panel",
            last_evaluated: "2026/01/01 00:00",
            trait_set: [{ trait_name: "Example condition", trait_xrefs: [{ db_source: "MONDO", db_id: "MONDO:0000001" }] }],
          },
        },
      },
    });
    throw new Error(`unexpected source URI ${uri}`);
  };

  try {
    await registerPublishedAcmgWorkbook(workspace, {
      datasetId: "fixture-acmg-workbook",
      version: "v1",
      sourceUri: "urn:fixture:published-acmg-workbook",
      citation: "Published workbook contract fixture",
      workbookBytes,
      expectedWorkbookDigest: digest(workbookBytes),
      recordedAt: "2026-07-13T08:00:00Z",
      validationRunId: "fixture-published-variant-validate",
      enforcePublishedCounts: false,
    });
    const resolved = await resolvePublishedVariantWithNcbi(workspace, {
      datasetId: "fixture-acmg-workbook",
      version: "v1",
      rowId: "ST12_150 ClinGen varinats:3",
      fetch: sourceFetch,
      recordedAt: "2026-07-13T09:00:00Z",
    });

    assert.equal(resolved.resolution.sourceVariantText, "NM_000001.1(GENE1):c.1A>G");
    assert.equal(resolved.resolution.transcriptHgvs, "NM_000001.1:c.1A>G");
    assert.equal(resolved.resolution.transcriptSpdi, "NM_000001.1:100:A:G");
    assert.deepEqual(resolved.resolution.rsids, ["123456"]);
    assert.equal(resolved.resolution.clinvar?.accessionVersion, "VCV000000777.2");
    assert.equal(resolved.resolution.clinvar?.classification, "Likely pathogenic");
    assert.deepEqual(resolved.resolution.genomicLocation, {
      assembly: "GRCh38",
      chromosome: "1",
      position1Based: 100,
      ref: "A",
      alt: "G",
      canonicalSpdi: "NC_000001.11:99:A:G",
    });
    assert.equal(resolved.resolution.sourceSnapshots.length, 4);
    assert.ok(resolved.registration.resolutionUri.startsWith("cas:sha256:"));
    for (const source of resolved.resolution.sourceSnapshots) {
      assert.ok(source.casUri.startsWith("cas:sha256:"));
      assert.ok(source.runId.startsWith("published-variant-source-"));
      assert.match(source.receiptDigest, /^sha256:[0-9a-f]{64}$/);
      await fs.access(join(workspace, ".pi", "bio-agent", "cas", "sha256", source.digest.slice("sha256:".length)));
    }

    const stored = await getPublishedVariantResolution(workspace, "fixture-acmg-workbook", "v1", "ST12_150 ClinGen varinats:3");
    assert.deepEqual(stored, resolved);
    const repeated = await resolvePublishedVariantWithNcbi(workspace, {
      datasetId: "fixture-acmg-workbook",
      version: "v1",
      rowId: "ST12_150 ClinGen varinats:3",
      fetch: async () => { throw new Error("an existing resolution must not refetch live sources"); },
    });
    assert.deepEqual(repeated, resolved);
    assert.equal(calls.length, 4);

    const store = await openBioStore(workspace);
    try {
      await materializeBioEdgesAsOf(store.conn, "2026-07-14T00:00:00Z");
      const edges = await store.conn.all<{ from_id: string; predicate: string; to_id: string }>(
        `SELECT from_id, predicate, to_id
         FROM bio_edges_as_of
         WHERE from_id LIKE 'variant-resolution:%' OR to_id LIKE 'benchmark-row:%'
         ORDER BY from_id, predicate, to_id`,
      );
      assert.ok(edges.some((edge) => edge.predicate === "resolves" && edge.to_id.endsWith("ST12_150 ClinGen varinats:3")));
      assert.equal(edges.filter((edge) => edge.predicate === "uses_run").length, 4);
    } finally {
      store.close();
    }

    const app = createWorkbenchApi({
      addons: [createPublishedVariantsWorkbenchAddon({
        workspace,
        datasetId: "fixture-acmg-workbook",
        version: "v1",
        featuredRowId: "ST12_150 ClinGen varinats:3",
      })],
    });
    const listedResponse = await app.request("/v1/published-variants?role=external_validation&q=GENE1");
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as {
      featuredRowId: string | null;
      totalCount: number;
      rows: Array<{ rowId: string; variantText: string; genes: string[] }>;
    };
    assert.equal(listed.featuredRowId, "ST12_150 ClinGen varinats:3");
    assert.ok(listed.totalCount > 0);
    assert.ok(listed.rows.some((row) => row.rowId === "ST12_150 ClinGen varinats:3"
      && row.variantText === "NM_000001.1(GENE1):c.1A>G"
      && row.genes.includes("GENE1")));

    const detailResponse = await app.request(`/v1/published-variants/${encodeURIComponent("ST12_150 ClinGen varinats:3")}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as {
      row: { rowId: string; sourceClassification: { raw: string }; referenceClassification: { raw: string } };
      resolutionUri: string | null;
      resolution: { transcriptHgvs: string; clinvar: { accessionVersion: string } | null; sourceSnapshots: Array<{ digest: string }> } | null;
    };
    assert.equal(detail.row.rowId, "ST12_150 ClinGen varinats:3");
    assert.ok(detail.row.sourceClassification.raw);
    assert.ok(detail.row.referenceClassification.raw);
    assert.equal(detail.resolutionUri, resolved.registration.resolutionUri);
    assert.equal(detail.resolution?.transcriptHgvs, "NM_000001.1:c.1A>G");
    assert.equal(detail.resolution?.clinvar?.accessionVersion, "VCV000000777.2");
    assert.equal(detail.resolution?.sourceSnapshots.length, 4);

    const openApi = await app.request("/openapi.json");
    const document = await openApi.json() as { paths: Record<string, unknown> };
    assert.ok(document.paths["/v1/published-variants"]);
    assert.ok(document.paths["/v1/published-variants/{rowId}"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
