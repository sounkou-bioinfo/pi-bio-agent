import type { ResourceRegistry, ResourceResolverSpec } from "../core/resources.js";

export const primitiveResourceResolvers: ResourceResolverSpec[] = [
  {
    schema: "pi-bio.resource_resolver.v1",
    name: "http.json-request",
    version: "0.1.0",
    description: "Declarative HTTP JSON request resolver. It models an external bio tool surface as a request template plus output contract; adapters inject credentials and enforce network policy.",
    modes: ["virtual"],
    request: {
      method: "GET",
      urlTemplate: "https://example.org/{path}",
      networkPolicy: "explicit-consent",
    },
    output: { mediaType: "application/json", format: "json" },
  },
  {
    schema: "pi-bio.resource_resolver.v1",
    name: "cas.local-file",
    version: "0.1.0",
    description: "Content-addressed local file resolver. The core stores algorithm, digest, media type, and size; adapters decide where bytes live.",
    modes: ["content_address", "reference"],
    output: { format: "bytes" },
  },
];

export const defaultBioResourceRegistry: ResourceRegistry = {
  schema: "pi-bio.resource_registry.v1",
  resolvers: primitiveResourceResolvers,
};

export function findResourceResolvers(query: string): ResourceResolverSpec[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return primitiveResourceResolvers;
  return primitiveResourceResolvers.filter((resolver) => {
    const hay = [resolver.name, resolver.description, ...resolver.modes].join("\n").toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}
