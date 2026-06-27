import type { Assembly, OntologyTermRef, Provenance, VariantKey } from "./types.js";

export interface VariantPredicate {
  id: string;
  label: string;
  description?: string;
  sqlWhere?: string;
  termSet?: string;
  parameters?: Record<string, unknown>;
  provenance?: Provenance[];
}

export interface AlleleFrequencyPredicate extends VariantPredicate {
  maxPopulationAf?: number;
  minPopulationAf?: number;
  frequencySources: string[];
  absentFrequencyPolicy: "unknown" | "include" | "exclude";
}

export interface ConsequencePredicate extends VariantPredicate {
  consequenceTerms: OntologyTermRef[];
  includeDescendants?: boolean;
}

export interface VariantQuestionDefaults {
  assembly?: Assembly;
  transcriptSet?: string;
  consequenceSource?: string;
  frequencySource?: string;
  passOnly?: boolean;
  genotypePredicate?: string;
}

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

export function cpraSql(chromCol: string, posCol: string, refCol: string, altCol: string): string {
  return `concat(${chromCol}, ':', ${posCol}::VARCHAR, ':', ${refCol}, ':', ${altCol})`;
}

export function carriedGenotypeSql(genotypeExpression: string): string {
  return `regexp_matches(${genotypeExpression}, '(^|[\\/|])([1-9][0-9]*)([\\/|]|$)')`;
}

export function frequencyPredicateSql(afExpression: string, policy: AlleleFrequencyPredicate): string {
  const clauses: string[] = [];
  if (policy.minPopulationAf != null) clauses.push(`${afExpression} >= ${Number(policy.minPopulationAf)}`);
  if (policy.maxPopulationAf != null) clauses.push(`${afExpression} < ${Number(policy.maxPopulationAf)}`);
  const present = `${afExpression} IS NOT NULL`;
  if (policy.absentFrequencyPolicy === "unknown" || policy.absentFrequencyPolicy === "exclude") return `(${present}${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""})`;
  return clauses.length ? `((${present} AND ${clauses.join(" AND ")}) OR ${afExpression} IS NULL)` : "TRUE";
}

export function consequencePredicateSql(consequenceExpression: string, terms: string[]): string {
  if (!terms.length) return "TRUE";
  return `(${terms.map((term) => `contains(lower(${consequenceExpression}), lower('${term.replace(/'/g, "''")}'))`).join(" OR ")})`;
}
