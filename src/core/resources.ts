import type { JsonValue } from "./json.js";
import type { Provenance } from "./types.js";

// sha256 ONLY — the store (fsCasStore) hashes/verifies sha256 and the metadata authority fails closed on anything
// else, so the type must not advertise algorithms no producer/store/GC backs. Widen only when a second algorithm
// ships with a real producer, store verification, GC rooting, and tests.
export type ContentAddressAlgorithm = "sha256";
export type ResourceHandleMode = "inline" | "reference" | "content_address" | "virtual";

export interface ContentAddress {
  algorithm: ContentAddressAlgorithm;
  digest: string;
  sizeBytes?: number;
  mediaType?: string;
}

export interface ResourcePointer {
  uri: string;
  mediaType?: string;
  format?: string;
  address?: ContentAddress;
}

// Nested inside a ResolutionReceipt (the persisted `result`); the receipt's schema governs. Never travels
// standalone and nothing reads a handle's schema, so it carries no envelope tag of its own.
export interface ResourceHandle {
  mode: ResourceHandleMode;
  name?: string;
  inline?: JsonValue;
  pointer?: ResourcePointer;
  address?: ContentAddress;
  provenance?: Provenance[];
}

/** A snapshot of an upstream source as it was at resolution time (the temporal anchor of a receipt). */
export interface SourceSnapshot {
  source: string;
  version?: string;
  releasedAt?: string;
  retrievedAt?: string;
}

/** Declaration of a resolver — serializable, the single resolver model. Implementation is bound separately. */
export interface BioResolverSpec {
  id: string;
  version: string;
  title: string;
  description: string;
  output: { mode: "inline" | "reference" | "content_address" | "table"; mediaType?: string; schemaRef?: string };
  temporal?: { kind: "snapshot" | "live" | "as_of"; source?: string; versionRequired?: boolean };
}

/** A named resource: opaque `params` resolved by a registered resolver into a ResourceHandle. */
export interface VirtualResourceSpec {
  id: string;
  title: string;
  kind: "virtual";
  resolver: string; // a registered resolver id
  params: Record<string, unknown>; // opaque to core; passed to the resolver
  schemaRef?: string;
}

export function contentAddressUri(address: ContentAddress): string {
  return `cas:${address.algorithm}:${address.digest}`;
}

export function isContentAddressUri(uri: string): boolean {
  return /^cas:sha256:[a-fA-F0-9]{64}$/.test(uri); // exactly 64 hex — parity with validateContentAddress (no malformed URI passes)
}
