import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GROUNDING_MODES, type GroundingRuntime, type PortIdentity } from "./phenotype-grounding.js";
import { loadRecordedGroundingRuntime } from "./recorded-grounding.js";

export type GroundingRuntimeFactory = (context: { workspace: string }) => GroundingRuntime | Promise<GroundingRuntime>;

function moduleSpecifier(value: string): string {
  return value.startsWith(".") || isAbsolute(value) ? pathToFileURL(resolve(value)).href : value;
}

function validIdentity(value: PortIdentity | undefined): boolean {
  return Boolean(value?.id && value.version);
}

/** Resolve a host module for live use, or the explicit recorded adapter used by the packaged example. */
export async function loadHostGroundingRuntime(workspace: string, modulePath?: string): Promise<GroundingRuntime> {
  if (!modulePath) return loadRecordedGroundingRuntime(join(workspace, "data", "grounding_proposals.json"));
  const loaded = await import(moduleSpecifier(modulePath)) as {
    default?: GroundingRuntimeFactory;
    createGroundingRuntime?: GroundingRuntimeFactory;
  };
  const factory = loaded.createGroundingRuntime ?? loaded.default;
  if (typeof factory !== "function") throw new Error(`grounding module '${modulePath}' must export createGroundingRuntime or a default factory`);
  const runtime = await factory({ workspace });
  const usesAugmenter = runtime && runtime.mode !== "none";
  if (!runtime?.contractDigest
    || !GROUNDING_MODES.includes(runtime.mode)
    || !validIdentity(runtime.agent?.identity) || typeof runtime.agent?.propose !== "function"
    || !validIdentity(runtime.reviewer?.identity) || typeof runtime.reviewer?.review !== "function"
    || runtime.agent.identity.id === runtime.reviewer.identity.id
    || (usesAugmenter && (!validIdentity(runtime.augmenter?.identity) || typeof runtime.augmenter?.augment !== "function"))) {
    throw new Error(`grounding module '${modulePath}' returned an incomplete GroundingRuntime`);
  }
  return runtime;
}
