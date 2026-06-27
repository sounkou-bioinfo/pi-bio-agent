import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { intervalOverlapsSql, makeInterval, normalizeSeqId, toOneBasedClosed, toZeroBasedHalfOpen, variantToInterval } from "../src/core/intervals.js";
import { normalizeTermRef, ontologySqlContract, termKey } from "../src/core/ontology.js";
import { carriedGenotypeSql, consequencePredicateSql, cpraSql, frequencyPredicateSql, makeVariantKey, variantStableKey, type AlleleFrequencyPredicate } from "../src/core/variants.js";

describe("genomic interval primitives", () => {
  test("normalizes seqids and validates coordinates", () => {
    assert.equal(normalizeSeqId(" chr1 "), "chr1");
    assert.throws(() => normalizeSeqId("   "), /seqid cannot be empty/);
    assert.throws(() => makeInterval({ seqid: "chr1", start: 0, end: 10, coordinateSystem: "1-based-closed" }), /start at 1/);
    assert.throws(() => makeInterval({ seqid: "chr1", start: 10, end: 9, coordinateSystem: "0-based-half-open" }), /end must be >= start/);
  });

  test("converts 1-based closed intervals to 0-based half-open and back", () => {
    const one = makeInterval({ seqid: "chr7", start: 101, end: 110, coordinateSystem: "1-based-closed", assembly: "GRCh38" });
    const zero = toZeroBasedHalfOpen(one);
    assert.deepEqual({ start: zero.start, end: zero.end, coordinateSystem: zero.coordinateSystem }, { start: 100, end: 110, coordinateSystem: "0-based-half-open" });
    const roundTrip = toOneBasedClosed(zero);
    assert.deepEqual({ start: roundTrip.start, end: roundTrip.end, coordinateSystem: roundTrip.coordinateSystem }, { start: 101, end: 110, coordinateSystem: "1-based-closed" });
  });

  test("generates overlap SQL for half-open and closed intervals", () => {
    assert.equal(intervalOverlapsSql("a", "b"), "(a.seqid = b.seqid AND a.start < b.end AND b.start < a.end)");
    assert.equal(intervalOverlapsSql("a", "b", { halfOpen: false }), "(a.seqid = b.seqid AND a.start <= b.end AND b.start <= a.end)");
  });

  test("maps variants to 1-based closed intervals using REF span", () => {
    const snv = makeVariantKey({ seqid: "chr1", pos: 10, ref: "A", alt: "G", assembly: "GRCh38", id: "rs-test" });
    assert.deepEqual(variantToInterval(snv), {
      kind: "genomic_interval",
      seqid: "chr1",
      start: 10,
      end: 10,
      coordinateSystem: "1-based-closed",
      assembly: "GRCh38",
      name: "rs-test",
    });
    const del = makeVariantKey({ seqid: "chr1", pos: 20, ref: "ATC", alt: "A" });
    assert.equal(variantToInterval(del).end, 22);
  });
});

describe("variant primitives", () => {
  test("creates stable variant keys", () => {
    const v = makeVariantKey({ seqid: "1", pos: 154453788, ref: "C", alt: "T", assembly: "GRCh38" });
    assert.equal(v.coordinateSystem, "1-based-closed");
    assert.equal(variantStableKey(v), "GRCh38:1:154453788:C:T");
    assert.throws(() => makeVariantKey({ seqid: "1", pos: 0, ref: "C", alt: "T" }), /1-based positive/);
    assert.throws(() => makeVariantKey({ seqid: "1", pos: 1, ref: "", alt: "T" }), /REF and ALT/);
  });

  test("generates variant SQL snippets deterministically", () => {
    assert.equal(cpraSql("chrom", "pos", "ref", "alt"), "concat(chrom, ':', pos::VARCHAR, ':', ref, ':', alt)");
    assert.equal(carriedGenotypeSql("gt"), "regexp_matches(gt, '(^|[\\/|])([1-9][0-9]*)([\\/|]|$)')");
    assert.equal(consequencePredicateSql("csq", []), "TRUE");
    assert.equal(consequencePredicateSql("csq", ["missense_variant", "Bob's term"]), "(contains(lower(csq), lower('missense_variant')) OR contains(lower(csq), lower('Bob''s term')))" );
  });

  test("generates allele-frequency predicates for absent-value policies", () => {
    const base: AlleleFrequencyPredicate = {
      id: "rare",
      label: "Rare",
      frequencySources: ["gnomad"],
      absentFrequencyPolicy: "exclude",
      maxPopulationAf: 0.01,
    };
    assert.equal(frequencyPredicateSql("af", base), "(af IS NOT NULL AND af < 0.01)");
    assert.equal(frequencyPredicateSql("af", { ...base, minPopulationAf: 0.001, absentFrequencyPolicy: "include" }), "((af IS NOT NULL AND af >= 0.001 AND af < 0.01) OR af IS NULL)");
    assert.equal(frequencyPredicateSql("af", { ...base, maxPopulationAf: undefined, absentFrequencyPolicy: "include" }), "TRUE");
    assert.equal(frequencyPredicateSql("af", { ...base, absentFrequencyPolicy: "unknown" }), "(af IS NOT NULL AND af < 0.01)");
  });
});

describe("ontology primitives", () => {
  test("normalizes term refs and preserves object refs", () => {
    assert.deepEqual(normalizeTermRef("HP:0001250"), { kind: "ontology_term", system: "HP", id: "0001250" });
    assert.deepEqual(normalizeTermRef("0001250", "HP"), { kind: "ontology_term", system: "HP", id: "0001250" });
    const ref = { kind: "ontology_term" as const, system: "MONDO", id: "0000001", label: "disease" };
    assert.equal(normalizeTermRef(ref), ref);
    assert.throws(() => normalizeTermRef("0001250"), /no system prefix/);
  });

  test("builds ontology keys and exposes SQL contract", () => {
    assert.equal(termKey({ system: "HP", id: "0001250" }), "HP:0001250");
    const contract = ontologySqlContract();
    assert.match(contract, /ontology_terms/);
    assert.match(contract, /term_set_members/);
  });
});
