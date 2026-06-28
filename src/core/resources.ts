import type { JsonValue } from "./tool-spec.js";
import type { Provenance } from "./types.js";

export type ContentAddressAlgorithm = "sha256" | "sha512" | "blake3";
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

export interface ResourceHandle {
  schema: "pi-bio.resource_handle.v1";
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
  return /^cas:(sha256|sha512|blake3):[a-fA-F0-9]+$/.test(uri);
}
