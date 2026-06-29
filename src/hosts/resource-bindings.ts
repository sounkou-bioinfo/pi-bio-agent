import type { DomainPackManifest } from "../core/manifest.js";

// Parameterized resources — "URL composition over params". A resource declares a URL (and/or request body)
// TEMPLATE with `{name}` slots; the AGENT supplies the values at query time. So the manifest declares the API
// SHAPE (the search endpoint, the annotation endpoint), NOT a specific query baked in. The agent composing
// `?q={query}` with its own term is the image-search pattern, generalized. Fail closed on an unfilled slot — a
// half-composed URL is never fetched.

// A slot is `{name}` (required) or `{name:default}` (optional — the manifest's default unless the agent binds it).
// The default runs to the closing brace, so it may contain commas etc. (e.g. {fieldList:obo_id,label}).
const SLOT = /\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;

/** Fill `{name}` / `{name:default}` slots in a template string from bindings. `encode` URL-encodes values (for a
 *  url); off for a body. A slot with neither a binding nor a default fails closed. */
export function fillTemplate(template: string, bindings: Record<string, unknown>, encode: boolean): string {
  return template.replace(SLOT, (_m, name: string, dflt: string | undefined) => {
    const raw = name in bindings ? String(bindings[name]) : dflt;
    if (raw === undefined) throw new Error(`resource template references '{${name}}' but no binding (and no default) was provided`);
    return encode ? encodeURIComponent(raw) : raw;
  });
}

/** Substitute bindings into an arbitrary param value. A string that is EXACTLY `{name}` is replaced by the raw
 *  binding (so a body can take an array/object, e.g. `"body": { "ids": "{ids}" }`); other strings get textual
 *  substitution; objects/arrays recurse. */
function bindValue(value: unknown, bindings: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}$/);
    if (exact) {
      // a whole-value slot becomes the RAW binding (so a body can take an array/object), else its default
      if (exact[1]! in bindings) return bindings[exact[1]!];
      if (exact[2] !== undefined) return exact[2];
      throw new Error(`resource template references '{${exact[1]}}' but no binding (and no default) was provided`);
    }
    return fillTemplate(value, bindings, false);
  }
  if (Array.isArray(value)) return value.map((v) => bindValue(v, bindings));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bindValue(v, bindings)]));
  return value;
}

/** Apply bindings to one resource's params: `url` is URL-encoded composition; `body` is structural substitution. */
export function bindResourceParams(params: Record<string, unknown>, bindings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };
  if (typeof out.url === "string") out.url = fillTemplate(out.url, bindings, true);
  if (out.body !== undefined) out.body = bindValue(out.body, bindings);
  return out;
}

/** Bind every resource in a manifest. Runs always (with `bindings` defaulting to {}), so a resource WITH a slot
 *  and NO binding fails closed — you must supply the query the manifest's shape requires. */
export function bindManifestResources(manifest: DomainPackManifest, bindings: Record<string, unknown>): DomainPackManifest {
  const resources = (manifest.provides?.resources ?? []).map((res) => ({ ...res, params: bindResourceParams(res.params as Record<string, unknown>, bindings) }));
  return { ...manifest, provides: { ...manifest.provides, resources } };
}
