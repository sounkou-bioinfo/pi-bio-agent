#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fsCasStore } from "pi-bio-agent";
import { defaultVepAnnotationRuntime, runClinicalGenomicsWorkbench } from "./clinical-genomics.js";
import {
  getClinicalCaseRevision,
  listClinicalCaseRevisions,
  registerClinicalCaseRevision,
  type ClinicalCaseMemberInput,
  type ClinicalCaseRelationshipInput,
  type ClinicalCaseAssetReferenceInput,
} from "./clinical-case-registry.js";
import { loadHostGroundingRuntime } from "./grounding-host.js";
import { localMonarchFixtureRuntime } from "./monarch-host.js";
import { localCandidateVariantSearchRuntime } from "./candidate-variant-search.js";
import { startWorkbenchServer } from "./server.js";

const args = process.argv.slice(2);
const command = args[0] ?? "run";

type FileAssetDescriptor = Omit<ClinicalCaseAssetReferenceInput, "digest"> & { path: string };
type CaseRevisionFileDescriptor = {
  caseId: string;
  revisionId?: string;
  parentRevisionId?: string;
  indexMemberIds?: string[];
  members: ClinicalCaseMemberInput[];
  relationships?: ClinicalCaseRelationshipInput[];
  assets: FileAssetDescriptor[];
  recordedAt?: string;
};

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

async function registerCaseDescriptor(workspaceArg: string, descriptorArg: string) {
  const workspace = resolve(workspaceArg);
  const descriptorPath = resolve(descriptorArg);
  const raw = objectRecord(JSON.parse(await fs.readFile(descriptorPath, "utf8")), "case descriptor");
  if (!Array.isArray(raw.assets)) throw new Error("case descriptor assets must be an array");
  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const assets: ClinicalCaseAssetReferenceInput[] = [];
  for (const [index, value] of raw.assets.entries()) {
    const asset = objectRecord(value, `case descriptor asset ${index}`);
    if (typeof asset.path !== "string" || !asset.path.trim()) throw new Error(`case descriptor asset ${index} requires a path`);
    const sourcePath = isAbsolute(asset.path) ? asset.path : resolve(dirname(descriptorPath), asset.path);
    const stored = await cas.putFile(sourcePath);
    const { path: _path, ...metadata } = asset;
    assets.push({
      ...(metadata as Omit<ClinicalCaseAssetReferenceInput, "digest">),
      digest: `sha256:${stored.address.digest}`,
    });
  }
  const { assets: _assetDescriptors, ...request } = raw;
  return registerClinicalCaseRevision(workspace, {
    ...(request as unknown as Omit<CaseRevisionFileDescriptor, "assets">),
    assets,
  });
}

if (command === "serve") {
  await startWorkbenchServer(args[1], args[2], args[3]);
} else if (command === "case") {
  const action = args[1];
  if (action === "register") {
    if (!args[2] || !args[3]) throw new Error("usage: pi-bio-workbench case register <workspace> <descriptor.json>");
    console.log(JSON.stringify(await registerCaseDescriptor(args[2], args[3]), null, 2));
  } else if (action === "list") {
    if (!args[2]) throw new Error("usage: pi-bio-workbench case list <workspace> [case-id]");
    console.log(JSON.stringify(await listClinicalCaseRevisions(resolve(args[2]), { ...(args[3] ? { caseId: args[3] } : {}) }), null, 2));
  } else if (action === "get") {
    if (!args[2] || !args[3] || !args[4]) throw new Error("usage: pi-bio-workbench case get <workspace> <case-id> <revision-id>");
    const revision = await getClinicalCaseRevision(resolve(args[2]), args[3], args[4]);
    if (!revision) throw new Error(`clinical case revision '${args[3]}:${args[4]}' was not found`);
    console.log(JSON.stringify(revision, null, 2));
  } else {
    throw new Error("usage: pi-bio-workbench case <register|list|get> ...");
  }
} else if (command === "run") {
  const exampleDir = resolve(args[1] ?? "examples/clinical-genomics");
  const caseRevisionId = args[3] && args[3] !== "-" ? args[3] : undefined;
  const result = await runClinicalGenomicsWorkbench({
    exampleDir,
    caseId: args[2] ?? "CASE-RD-001",
    grounding: await loadHostGroundingRuntime(exampleDir, args[5]),
    hypotheses: localMonarchFixtureRuntime(exampleDir),
    variantSearch: localCandidateVariantSearchRuntime(exampleDir),
    vep: defaultVepAnnotationRuntime(),
    ...(caseRevisionId ? { caseRevisionId } : {}),
    ...(args[4] ? { analysisId: args[4] } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error("usage: pi-bio-workbench [case <register|list|get> ... | run <workspace> <case-id> <case-revision-id|-> [analysis-id] [grounding-module] | serve <workspace> [port] [grounding-module]]");
}
