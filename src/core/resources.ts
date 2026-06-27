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

export interface HttpRequestTemplate {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  urlTemplate: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyTemplate?: JsonValue;
  timeoutSeconds?: number;
  networkPolicy?: "forbidden" | "explicit-consent" | "allowed";
}

export interface ResourceResolverSpec {
  schema: "pi-bio.resource_resolver.v1";
  name: string;
  version: string;
  description: string;
  modes: ResourceHandleMode[];
  request?: HttpRequestTemplate;
  output?: {
    mediaType?: string;
    format?: string;
    jsonSchema?: Record<string, JsonValue | undefined>;
  };
  provenance?: Provenance[];
}

export interface ResourceHandle {
  schema: "pi-bio.resource_handle.v1";
  mode: ResourceHandleMode;
  name?: string;
  inline?: JsonValue;
  pointer?: ResourcePointer;
  address?: ContentAddress;
  resolver?: {
    name: string;
    query: JsonValue;
  };
  provenance?: Provenance[];
}

export interface ResolvedResource {
  schema: "pi-bio.resolved_resource.v1";
  handle: ResourceHandle;
  bytes?: Uint8Array;
  json?: JsonValue;
  pointer?: ResourcePointer;
  fetchedAt?: string;
  provenance?: Provenance[];
}

export interface ResourceRegistry {
  schema: "pi-bio.resource_registry.v1";
  resolvers: ResourceResolverSpec[];
  handles?: ResourceHandle[];
}

const RESOLVER_NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function validateResourceResolverSpec(spec: ResourceResolverSpec): string[] {
  const errors: string[] = [];
  if (spec.schema !== "pi-bio.resource_resolver.v1") errors.push("schema must be pi-bio.resource_resolver.v1");
  if (!RESOLVER_NAME_RE.test(spec.name)) errors.push("invalid resolver name");
  if (!spec.version.trim()) errors.push("version is required");
  if (!spec.description.trim()) errors.push("description is required");
  if (!spec.modes.length) errors.push("at least one mode is required");
  if (spec.request && spec.request.networkPolicy === "forbidden") errors.push("request templates cannot declare forbidden network policy");
  return errors;
}

export function contentAddressUri(address: ContentAddress): string {
  return `cas:${address.algorithm}:${address.digest}`;
}

export function isContentAddressUri(uri: string): boolean {
  return /^cas:(sha256|sha512|blake3):[a-fA-F0-9]+$/.test(uri);
}
