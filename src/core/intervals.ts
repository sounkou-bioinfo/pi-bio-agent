import type { GenomicInterval, VariantKey } from "./types.js";

export function normalizeSeqId(seqid: string): string {
  const trimmed = seqid.trim();
  if (!trimmed) throw new Error("seqid cannot be empty");
  return trimmed;
}

export function makeInterval(input: Omit<GenomicInterval, "kind">): GenomicInterval {
  const seqid = normalizeSeqId(input.seqid);
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end)) throw new Error("interval coordinates must be integers");
  if (input.coordinateSystem === "1-based-closed" && input.start < 1) throw new Error("1-based intervals start at 1");
  if (input.coordinateSystem === "0-based-half-open" && input.start < 0) throw new Error("0-based intervals start at 0");
  if (input.end < input.start) throw new Error("interval end must be >= start");
  return { kind: "genomic_interval", ...input, seqid };
}

export function toZeroBasedHalfOpen(interval: GenomicInterval): GenomicInterval {
  if (interval.coordinateSystem === "0-based-half-open") return interval;
  return {
    ...interval,
    coordinateSystem: "0-based-half-open",
    start: interval.start - 1,
  };
}

export function toOneBasedClosed(interval: GenomicInterval): GenomicInterval {
  if (interval.coordinateSystem === "1-based-closed") return interval;
  return {
    ...interval,
    coordinateSystem: "1-based-closed",
    start: interval.start + 1,
  };
}

export function intervalOverlapsSql(aAlias: string, bAlias: string, options?: { halfOpen?: boolean }): string {
  const aStart = `${aAlias}.start`;
  const aEnd = `${aAlias}.end`;
  const bStart = `${bAlias}.start`;
  const bEnd = `${bAlias}.end`;
  const sameSeqid = `${aAlias}.seqid = ${bAlias}.seqid`;
  if (options?.halfOpen ?? true) return `(${sameSeqid} AND ${aStart} < ${bEnd} AND ${bStart} < ${aEnd})`;
  return `(${sameSeqid} AND ${aStart} <= ${bEnd} AND ${bStart} <= ${aEnd})`;
}

export function variantToInterval(variant: VariantKey): GenomicInterval {
  return makeInterval({
    seqid: variant.seqid,
    start: variant.pos,
    end: variant.pos + Math.max(variant.ref.length, 1) - 1,
    coordinateSystem: "1-based-closed",
    assembly: variant.assembly,
    name: variant.id,
  });
}
