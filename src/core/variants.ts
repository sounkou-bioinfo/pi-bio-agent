import type { Assembly, VariantKey } from "./types.js";

// Variant identity primitives only. Question-level SQL (frequency/consequence/genotype filters, CPRA
// expressions) deliberately does NOT live here: that is per-question policy the agent composes as SQL
// over stable views, or that lives as declarative predicate-registry data / ontology term sets / study-
// note caveats — not as bespoke core SQL builders. See docs/design.md "Core boundary".

export function makeVariantKey(input: Omit<VariantKey, "kind" | "coordinateSystem"> & { assembly?: Assembly }): VariantKey {
  if (!Number.isInteger(input.pos) || input.pos < 1) throw new Error("variant positions are 1-based positive integers");
  if (!input.ref || !input.alt) throw new Error("variant REF and ALT are required");
  return {
    kind: "variant",
    coordinateSystem: "1-based-closed",
    ...input,
  };
}

export function variantStableKey(variant: VariantKey): string {
  return [variant.assembly ?? "assembly:unknown", variant.seqid, variant.pos, variant.ref, variant.alt].join(":");
}
