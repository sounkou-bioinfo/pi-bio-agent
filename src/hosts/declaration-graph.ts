import type { BioManifest } from "../core/manifest.js";
import { validateBioManifest } from "../core/manifest.js";
import { canonicalDigest } from "../core/reproducibility.js";
import type { SqlConn } from "../core/ports.js";
import { createBioObservationSchema, recordObservation, type BioObservationInput } from "../duckdb/observations.js";

export interface ManifestDeclarationIds {
  manifest: string;
  resolvers: Record<string, string>;
  resources: Record<string, string>;
  operations: Record<string, string>;
  termSets: Record<string, string>;
}

const idPart = (value: string): string => encodeURIComponent(value);

export function manifestDeclarationIds(manifest: BioManifest): ManifestDeclarationIds {
  const owner = `${idPart(manifest.id)}@${idPart(manifest.version)}`;
  return {
    manifest: `manifest:${owner}`,
    resolvers: Object.fromEntries((manifest.provides.resolvers ?? []).map((resolver) => [resolver.id, `resolver:${owner}:${idPart(resolver.id)}@${idPart(resolver.version)}`])),
    resources: Object.fromEntries((manifest.provides.resources ?? []).map((resource) => [resource.id, `resource:${owner}:${idPart(resource.id)}`])),
    operations: Object.fromEntries((manifest.provides.operations ?? []).map((operation) => [operation.id, `operation:${owner}:${idPart(operation.id)}@${idPart(operation.version)}`])),
    termSets: Object.fromEntries((manifest.provides.termSets ?? []).map((termSet) => [termSet.id, `term-set:${owner}:${idPart(termSet.id)}`])),
  };
}

function stableObservation(input: Omit<BioObservationInput, "observationId">): BioObservationInput {
  return {
    ...input,
    observationId: canonicalDigest([
      "declaration_graph",
      input.statementKey,
      input.subjectId,
      input.predicate,
      input.objectId ?? null,
      input.value ?? null,
      input.source ?? null,
      input.digest ?? null,
      input.attrs ?? null,
    ]),
  };
}

/** Project authored declarations into ordinary temporal observations. Re-recording the same content from the same
 * source is idempotent; a changed digest becomes a new revision of the same declaration slot. */
export function projectManifestDeclarations(args: {
  manifest: BioManifest;
  manifestDigest?: string;
  recordedAt: string;
  source?: string;
  run?: { runId: string; kind: "query" | "operation"; identity: string; resources?: readonly string[] };
}): BioObservationInput[] {
  const errors = validateBioManifest(args.manifest);
  if (errors.length > 0) throw new Error(`cannot project invalid manifest '${args.manifest?.id ?? "<unknown>"}': ${errors.join("; ")}`);
  const manifest = args.manifest;
  const digest = args.manifestDigest ?? canonicalDigest(manifest);
  const ids = manifestDeclarationIds(manifest);
  const common = { recordedAt: args.recordedAt, source: args.source, digest };
  const out: BioObservationInput[] = [];
  const declaration = (node: string, value: Record<string, unknown>) => out.push(stableObservation({
    statementKey: `${node}:declaration`, subjectId: node, predicate: "declaration", value, ...common,
  }));
  const edge = (subjectId: string, predicate: string, objectId: string) => out.push(stableObservation({
    statementKey: `${subjectId}:${predicate}:${objectId}`, subjectId, predicate, objectId,
    attrs: { manifest: ids.manifest, manifest_digest: digest }, ...common,
  }));

  declaration(ids.manifest, { kind: "manifest", id: manifest.id, version: manifest.version, title: manifest.title, description: manifest.description, digest });
  for (const resolver of manifest.provides.resolvers ?? []) {
    const node = ids.resolvers[resolver.id]!;
    declaration(node, { kind: "resolver", id: resolver.id, version: resolver.version, title: resolver.title, output: resolver.output });
    edge(ids.manifest, "provides", node);
  }
  for (const resource of manifest.provides.resources ?? []) {
    const node = ids.resources[resource.id]!;
    declaration(node, {
      kind: "resource", id: resource.id, title: resource.title, resolver: resource.resolver,
      params_digest: canonicalDigest(resource.params), ...(resource.schemaRef ? { schema_ref: resource.schemaRef } : {}),
    });
    edge(ids.manifest, "provides", node);
    edge(node, "resolved_by", ids.resolvers[resource.resolver]!);
  }
  for (const operation of manifest.provides.operations ?? []) {
    const node = ids.operations[operation.id]!;
    declaration(node, {
      kind: "operation", id: operation.id, version: operation.version, title: operation.title,
      transport: operation.transport, required_resources: operation.sql?.requiredResources ?? [],
      sql_digest: operation.sql ? canonicalDigest(operation.sql.sqlTemplate) : undefined,
    });
    edge(ids.manifest, "provides", node);
    for (const resourceId of operation.sql?.requiredResources ?? []) edge(node, "requires", ids.resources[resourceId]!);
  }
  for (const termSet of manifest.provides.termSets ?? []) {
    const node = ids.termSets[termSet.id]!;
    declaration(node, {
      kind: "term_set", id: termSet.id, title: termSet.title, ordered: termSet.ordered === true,
      member_count: termSet.members.length, members_digest: canonicalDigest(termSet.members),
    });
    edge(ids.manifest, "provides", node);
  }

  if (args.run) {
    const runNode = `run:${args.run.runId}`;
    edge(runNode, "uses_manifest", ids.manifest);
    if (args.run.kind === "operation" && ids.operations[args.run.identity]) edge(runNode, "executes_operation", ids.operations[args.run.identity]!);
    for (const resourceId of args.run.resources ?? []) {
      const resourceNode = ids.resources[resourceId];
      if (resourceNode) edge(runNode, "uses_resource", resourceNode);
    }
  }
  return out;
}

export async function recordManifestDeclarations(conn: SqlConn, args: Parameters<typeof projectManifestDeclarations>[0]): Promise<number> {
  await createBioObservationSchema(conn, { ifNotExists: true });
  const observations = projectManifestDeclarations(args);
  for (const observation of observations) await recordObservation(conn, observation);
  return observations.length;
}
