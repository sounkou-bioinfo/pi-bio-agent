import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { intervalOverlapsSql, makeInterval, normalizeSeqId, toOneBasedClosed, toZeroBasedHalfOpen, variantToInterval } from "../src/core/intervals.js";
import { normalizeTermRef, termKey } from "../src/core/ontology.js";
import { makeVariantKey, variantStableKey } from "../src/core/variants.js";

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
});

describe("ontology primitives", () => {
  test("normalizes term refs and preserves object refs", () => {
    assert.deepEqual(normalizeTermRef("HP:0001250"), { kind: "ontology_term", system: "HP", id: "0001250" });
    assert.deepEqual(normalizeTermRef("0001250", "HP"), { kind: "ontology_term", system: "HP", id: "0001250" });
    const ref = { kind: "ontology_term" as const, system: "MONDO", id: "0000001", label: "disease" };
    assert.equal(normalizeTermRef(ref), ref);
    assert.throws(() => normalizeTermRef("0001250"), /no system prefix/);
  });

  test("builds ontology term keys", () => {
    assert.equal(termKey({ system: "HP", id: "0001250" }), "HP:0001250");
  });
});
