import type { BioManifest } from "../core/manifest.js";
import type { VirtualResourceSpec } from "../core/resources.js";

export type HostCapabilityStatus = "available" | "unavailable" | "unknown";
export type ManifestAdmission = "ready" | "blocked" | "unknown";

export interface ManifestCapabilityRequirement {
  id: string;
  status: HostCapabilityStatus;
}

export interface ManifestResourceAdmission {
  id: string;
  resolver: string;
  resolverBinding: "bound" | "unbound";
  requirements: ManifestCapabilityRequirement[];
  admission: ManifestAdmission;
  reasons: string[];
}

export interface ManifestOperationAdmission {
  id: string;
  requiredResources: string[];
  admission: ManifestAdmission;
  reasons: string[];
}

export interface ManifestHostAssessment {
  resources: ManifestResourceAdmission[];
  operations: ManifestOperationAdmission[];
  requirements: string[];
}

/** Runtime requirements visible from the authored resource. Names are open host vocabulary, not a core enum. */
export function resourceCapabilityRequirements(resource: VirtualResourceSpec): string[] {
  const requirements = new Set<string>();
  if (resource.resolver === "http.get") requirements.add("host.fetch");
  if (resource.resolver === "compute.run") requirements.add("compute.runner");
  if (resource.resolver === "duckhts.read_bcf") requirements.add("duckdb.extension.duckhts");

  const extensions = resource.params?.extensions;
  if (Array.isArray(extensions)) {
    for (const extension of extensions) {
      if (typeof extension === "string" && extension.length > 0) requirements.add(`duckdb.extension.${extension}`);
    }
  }

  if (resource.resolver !== "http.get" && resource.resolver !== "compute.run") {
    const declaredSources = Array.isArray(resource.params?.declaredSources) ? resource.params.declaredSources : [];
    const candidates = [resource.params?.path, ...declaredSources];
    if (candidates.some((source) => typeof source === "string" && /^https?:\/\//i.test(source))) requirements.add("network.egress");
  }
  return [...requirements].sort();
}

/** Assess only host admission. `ready` means the host has bound every required resolver and attested every
 * declared capability; source validity and query success are still established by executing the run. */
export function assessManifestHost(
  manifest: BioManifest,
  host: {
    resolverBindings: ReadonlySet<string>;
    capabilities?: Readonly<Record<string, HostCapabilityStatus>>;
  },
): ManifestHostAssessment {
  const resources = (manifest.provides.resources ?? []).map<ManifestResourceAdmission>((resource) => {
    const bound = host.resolverBindings.has(resource.resolver);
    const requirements = resourceCapabilityRequirements(resource).map((id) => ({
      id,
      status: host.capabilities?.[id] ?? "unknown",
    }));
    const unavailable = requirements.filter((requirement) => requirement.status === "unavailable");
    const unknown = requirements.filter((requirement) => requirement.status === "unknown");
    const reasons = [
      ...(!bound ? [`resolver '${resource.resolver}' has no host binding`] : []),
      ...unavailable.map((requirement) => `capability '${requirement.id}' is unavailable`),
      ...unknown.map((requirement) => `capability '${requirement.id}' has not been attested by the host`),
    ];
    return {
      id: resource.id,
      resolver: resource.resolver,
      resolverBinding: bound ? "bound" : "unbound",
      requirements,
      admission: !bound || unavailable.length > 0 ? "blocked" : unknown.length > 0 ? "unknown" : "ready",
      reasons,
    };
  });

  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const operations = (manifest.provides.operations ?? []).map<ManifestOperationAdmission>((operation) => {
    const requiredResources = operation.sql?.requiredResources ?? [];
    const missing = requiredResources.filter((id) => !byId.has(id));
    const required = requiredResources.flatMap((id) => {
      const resource = byId.get(id);
      return resource ? [resource] : [];
    });
    const blocked = required.filter((resource) => resource.admission === "blocked");
    const unknown = required.filter((resource) => resource.admission === "unknown");
    return {
      id: operation.id,
      requiredResources,
      admission: missing.length > 0 || blocked.length > 0 ? "blocked" : unknown.length > 0 ? "unknown" : "ready",
      reasons: [
        ...missing.map((id) => `required resource '${id}' is not declared`),
        ...blocked.flatMap((resource) => resource.reasons.map((reason) => `resource '${resource.id}': ${reason}`)),
        ...unknown.flatMap((resource) => resource.reasons.map((reason) => `resource '${resource.id}': ${reason}`)),
      ],
    };
  });

  return {
    resources,
    operations,
    requirements: [...new Set(resources.flatMap((resource) => resource.requirements.map((requirement) => requirement.id)))].sort(),
  };
}
