import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fsCasStore, materializeBioEdgesAsOf, openBioStore } from "pi-bio-agent";
import {
  ClinicalCaseRegistryInputError,
  getClinicalCaseRevision,
  listClinicalCaseRevisions,
  registerClinicalCaseRevision,
  type RegisterClinicalCaseRevisionRequest,
} from "../src/clinical-case-registry.js";

async function workspace(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-case-registry-"));
}

function revisionInput(revisionId: string, narrative: string, parentRevisionId?: string): RegisterClinicalCaseRevisionRequest {
  return {
    caseId: "family-001",
    revisionId,
    ...(parentRevisionId ? { parentRevisionId } : {}),
    indexMemberIds: ["proband"],
    members: [
      { memberId: "proband", role: "proband", affectedStatus: "affected", sex: "female" },
      { memberId: "mother", role: "mother", affectedStatus: "unaffected", sex: "female" },
      { memberId: "father", role: "father", affectedStatus: "unaffected", sex: "male" },
      { memberId: "sibling", role: "sibling", affectedStatus: "unknown", sex: "unknown" },
    ],
    relationships: [
      { fromMemberId: "mother", predicate: "parent_of", toMemberId: "proband", sourceAssetId: "pedigree" },
      { fromMemberId: "father", predicate: "parent_of", toMemberId: "proband", sourceAssetId: "pedigree" },
      { fromMemberId: "proband", predicate: "sibling_of", toMemberId: "sibling", sourceAssetId: "pedigree" },
    ],
    assets: [
      {
        assetId: "narrative",
        kind: "clinical_narrative",
        mediaType: "text/plain",
        bytes: Buffer.from(narrative),
        memberIds: ["proband"],
      },
      {
        assetId: "variants",
        kind: "variant_set",
        mediaType: "text/plain",
        format: "vcf",
        assembly: "GRCh38",
        bytes: Buffer.from("##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tP\tM\tF\n17\t43093464\t.\tA\tT\t.\tPASS\t.\tGT\t0/1\t0/0\t0/0\n"),
        memberIds: ["proband", "mother", "father"],
        sampleMappings: [
          { memberId: "proband", sampleId: "P" },
          { memberId: "mother", sampleId: "M" },
          { memberId: "father", sampleId: "F" },
        ],
      },
      {
        assetId: "pedigree",
        kind: "pedigree",
        mediaType: "text/plain",
        format: "ped",
        bytes: Buffer.from("family-001 P F M 2 2\n"),
        memberIds: ["proband", "mother", "father", "sibling"],
      },
    ],
  };
}

test("clinical case revisions keep family assets in CAS and project only pseudonymous graph metadata", async () => {
  const dir = await workspace();
  const narrative = "The proband has developmental delay and hypotonia.";
  const first = await registerClinicalCaseRevision(dir, {
    ...revisionInput("r-1", narrative),
    recordedAt: "2026-07-01T12:00:00Z",
  });

  assert.equal(first.parentRevisionId, undefined, "a first revision does not invent a prior assessment or revision");
  assert.deepEqual(first.indexMemberIds, ["proband"]);
  assert.equal(first.members.length, 4);
  assert.equal(first.assets.length, 3);
  assert.equal(first.assets.find((asset) => asset.assetId === "variants")?.sampleMappings.length, 3);
  assert.equal(first.assets.some((asset) => asset.kind === "prior_assessment"), false);

  const cas = fsCasStore(join(dir, ".pi", "bio-agent", "cas"));
  const narrativeAsset = first.assets.find((asset) => asset.assetId === "narrative");
  assert.ok(narrativeAsset);
  assert.equal(await cas.has({ algorithm: "sha256", digest: narrativeAsset.digest.slice("sha256:".length) }), true);
  assert.equal(
    await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: narrativeAsset.digest.slice("sha256:".length) }), "utf8"),
    narrative,
  );

  const store = await openBioStore(dir);
  try {
    const [{ rawNarrativeCount }] = await store.conn.all<{ rawNarrativeCount: bigint }>(
      "SELECT count(*) AS rawNarrativeCount FROM bio_observations WHERE value_json LIKE ?",
      [`%${narrative}%`],
    );
    assert.equal(Number(rawNarrativeCount), 0, "raw clinical text stays in CAS, not ledger JSON");
    await materializeBioEdgesAsOf(store.conn, "2026-07-02T00:00:00Z");
    const edges = await store.conn.all<{ from_id: string; predicate: string; to_id: string }>(
      "SELECT from_id, predicate, to_id FROM bio_edges_as_of WHERE from_id LIKE 'case:%' OR from_id LIKE 'case-member:%' ORDER BY from_id, predicate, to_id",
    );
    assert.ok(edges.some((edge) => edge.from_id === "case:family-001" && edge.predicate === "has_input_revision" && edge.to_id === "case-revision:family-001:r-1"));
    assert.ok(edges.some((edge) => edge.from_id === "case-member:family-001:r-1:mother" && edge.predicate === "clinical:parent_of" && edge.to_id === "case-member:family-001:r-1:proband"));
    assert.ok(edges.some((edge) => edge.from_id === "case-member:family-001:r-1:father" && edge.predicate === "clinical:parent_of" && edge.to_id === "case-member:family-001:r-1:proband"));
  } finally {
    store.close();
  }

  const fetched = await getClinicalCaseRevision(dir, "family-001", "r-1");
  assert.deepEqual(fetched, first);
});

test("clinical case revisions accept large assets staged through the workspace CAS", async () => {
  const dir = await workspace();
  const sourcePath = join(dir, "family.vcf.gz");
  const sourceBytes = Buffer.from("registered variant bytes\n");
  await fs.writeFile(sourcePath, sourceBytes);
  const cas = fsCasStore(join(dir, ".pi", "bio-agent", "cas"));
  const stored = await cas.putFile(sourcePath);
  const input = revisionInput("r-streamed", "Streamed asset narrative.");
  input.assets = input.assets.map((asset) => {
    if (asset.assetId !== "variants" || !("bytes" in asset)) return asset;
    const { bytes: _bytes, ...metadata } = asset;
    return { ...metadata, digest: `sha256:${stored.address.digest}` as const };
  });

  const revision = await registerClinicalCaseRevision(dir, input);
  const variants = revision.assets.find((asset) => asset.assetId === "variants");
  assert.equal(variants?.digest, `sha256:${stored.address.digest}`);
  assert.equal(variants?.sizeBytes, sourceBytes.length);
});

test("clinical case revisions are immutable, successor-linked, and validate family references", async () => {
  const dir = await workspace();
  const first = await registerClinicalCaseRevision(dir, {
    ...revisionInput("r-1", "First narrative."),
    recordedAt: "2026-07-01T12:00:00Z",
  });
  const repeated = await registerClinicalCaseRevision(dir, {
    ...revisionInput("r-1", "First narrative."),
    recordedAt: "2026-07-01T12:01:00Z",
  });
  assert.deepEqual(repeated, first, "re-registering identical immutable content is idempotent");

  await assert.rejects(
    () => registerClinicalCaseRevision(dir, {
      ...revisionInput("r-1", "Different narrative."),
      recordedAt: "2026-07-01T12:02:00Z",
    }),
    (error: unknown) => error instanceof ClinicalCaseRegistryInputError && /different immutable content/.test(error.message),
  );

  const successor = await registerClinicalCaseRevision(dir, {
    ...revisionInput("r-2", "Second narrative.", "r-1"),
    recordedAt: "2026-07-02T12:00:00Z",
  });
  assert.equal(successor.parentRevisionId, "r-1");
  const summaries = await listClinicalCaseRevisions(dir, { caseId: "family-001" });
  assert.deepEqual(summaries.map((summary) => [summary.revisionId, summary.parentRevisionId]), [["r-2", "r-1"], ["r-1", null]]);

  await assert.rejects(
    () => registerClinicalCaseRevision(dir, {
      ...revisionInput("r-3", "Bad relationship."),
      relationships: [{ fromMemberId: "missing", predicate: "parent_of", toMemberId: "proband" }],
      recordedAt: "2026-07-03T12:00:00Z",
    }),
    (error: unknown) => error instanceof ClinicalCaseRegistryInputError && /unknown member/.test(error.message),
  );
});

test("derived clinical case revision identities are stable across attribute key order", async () => {
  const leftWorkspace = await workspace();
  const rightWorkspace = await workspace();
  const left = revisionInput("placeholder", "Same source inputs.");
  const right = revisionInput("placeholder", "Same source inputs.");
  left.revisionId = undefined;
  right.revisionId = undefined;
  left.members = left.members.map((member) => member.memberId === "proband"
    ? { ...member, attributes: { source: "intake", detail: { alpha: 1, beta: 2 } } }
    : member);
  right.members = right.members.map((member) => member.memberId === "proband"
    ? { ...member, attributes: { detail: { beta: 2, alpha: 1 }, source: "intake" } }
    : member);
  left.relationships = (left.relationships ?? []).map((relationship) => relationship.fromMemberId === "mother"
    ? { ...relationship, attributes: { evidence: "pedigree", detail: { alpha: 1, beta: 2 } } }
    : relationship);
  right.relationships = (right.relationships ?? []).map((relationship) => relationship.fromMemberId === "mother"
    ? { ...relationship, attributes: { detail: { beta: 2, alpha: 1 }, evidence: "pedigree" } }
    : relationship);
  left.assets = left.assets.map((asset) => asset.assetId === "variants"
    ? { ...asset, attributes: { source: "laboratory", metadata: { alpha: 1, beta: 2 } } }
    : asset);
  right.assets = right.assets.map((asset) => asset.assetId === "variants"
    ? { ...asset, attributes: { metadata: { beta: 2, alpha: 1 }, source: "laboratory" } }
    : asset);

  const leftRevision = await registerClinicalCaseRevision(leftWorkspace, left);
  const rightRevision = await registerClinicalCaseRevision(rightWorkspace, right);
  assert.equal(leftRevision.revisionId, rightRevision.revisionId);
  assert.deepEqual(leftRevision, rightRevision);
});
