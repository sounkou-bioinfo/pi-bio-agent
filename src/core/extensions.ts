import type { ResourceResolverSpec } from "./resources.js";
import { validateResourceResolverSpec } from "./resources.js";
import type { BioToolSpec } from "./tool-spec.js";
import { defineBioToolSpec } from "./tool-spec.js";

export interface BioSkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface BioExtensionRegistrySnapshot {
  schema: "pi-bio.extension_registry.v1";
  toolSpecs: BioToolSpec[];
  resourceResolvers: ResourceResolverSpec[];
  skillDrafts: BioSkillDraft[];
}

export interface BioExtensionAPI {
  registerToolSpec(spec: BioToolSpec): void;
  registerResourceResolver(spec: ResourceResolverSpec): void;
  registerSkillDraft(draft: BioSkillDraft): void;
}

export type BioExtensionFactory = (api: BioExtensionAPI) => void | Promise<void>;

export function createBioExtensionRegistry(): BioExtensionAPI & { snapshot(): BioExtensionRegistrySnapshot } {
  const toolSpecs = new Map<string, BioToolSpec>();
  const resourceResolvers = new Map<string, ResourceResolverSpec>();
  const skillDrafts = new Map<string, BioSkillDraft>();

  return {
    registerToolSpec(spec) {
      const normalized = defineBioToolSpec(spec);
      toolSpecs.set(`${normalized.name}@${normalized.version}`, normalized);
    },
    registerResourceResolver(spec) {
      const errors = validateResourceResolverSpec(spec);
      if (errors.length) throw new Error(`invalid resource resolver ${spec.name || "<unnamed>"}: ${errors.join("; ")}`);
      resourceResolvers.set(`${spec.name}@${spec.version}`, spec);
    },
    registerSkillDraft(draft) {
      if (!draft.name || !draft.description || !draft.body) throw new Error("skill draft requires name, description, and body");
      skillDrafts.set(draft.name, draft);
    },
    snapshot() {
      return {
        schema: "pi-bio.extension_registry.v1",
        toolSpecs: [...toolSpecs.values()],
        resourceResolvers: [...resourceResolvers.values()],
        skillDrafts: [...skillDrafts.values()],
      };
    },
  };
}
