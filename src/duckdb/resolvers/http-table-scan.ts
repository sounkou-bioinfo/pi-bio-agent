import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BioResolverImpl } from "../../core/ports.js";

// ONE generic HTTP resolver — not a per-API client. It GETs a declared URL and materializes the response into
// a DuckDB table via a native reader (json/csv), so any HTTP/JSON source (OLS4 search, OpenTargets, gnomAD,
// an arbitrary REST endpoint) becomes queryable with the SAME operation SQL — the URL/shape are DATA in the
// manifest, never code. Network is INJECTED (the host passes a fetch impl), so there is no ambient network:
// `npm run check` binds a mock; a real host binds globalThis.fetch. It is NOT a default built-in — a manifest
// that declares it fails closed until a host explicitly binds it with a fetch, which is the network opt-in.
// Fail-closed: only http(s) URLs, non-2xx throws, no retry/fallback. The receipt stamps the URL + a sha256 of
// the exact bytes fetched, so the run records precisely what came back.

export type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<FetchResponse>;

const READERS: Record<string, string> = { json: "read_json_auto", ndjson: "read_json_auto", csv: "read_csv_auto" };

/** Build the HTTP table resolver bound to a host-supplied fetch. Tests pass a mock; production passes fetch. */
export function httpTableResolver(fetchImpl: FetchLike): BioResolverImpl {
  return async (resource, ctx) => {
    const p = resource.params as { url?: unknown; table?: unknown; format?: unknown; method?: unknown; headers?: unknown };
    if (typeof p.url !== "string" || !/^https?:\/\//i.test(p.url)) {
      throw new Error("http resolver requires params.url to be an http(s) URL (explicit remote; no local/file fetch)");
    }
    if (typeof p.table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.table)) {
      throw new Error("http resolver requires params.table to be a valid SQL identifier");
    }
    const format = typeof p.format === "string" ? p.format : "json";
    const reader = READERS[format];
    if (!reader) throw new Error(`http resolver: unknown format '${format}' (expected json, ndjson, or csv)`);
    const headers = (p.headers && typeof p.headers === "object" ? p.headers : {}) as Record<string, string>;
    // http.get is read-only by name and policy: GET only, so the effect surface can't silently widen to
    // writes via params.method.
    const method = p.method === undefined ? "GET" : p.method;
    if (method !== "GET") throw new Error("http.get supports GET only");

    const res = await fetchImpl(p.url, { method: "GET", headers });
    if (!res.ok) throw new Error(`http resolver: GET ${p.url} returned status ${res.status}`); // fail closed, no retry/fallback
    const body = await res.text();
    const digest = createHash("sha256").update(body).digest("hex");

    // Materialize through a resolver-owned temp file (the native reader parses it); clean up always. This is a
    // resolver DDL (CREATE), not operation SQL, so it never flows through the read-only guard.
    const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-http-"));
    const file = join(dir, format === "csv" ? "body.csv" : "body.json");
    await fs.writeFile(file, body, "utf8");
    try {
      await ctx.conn.run(`CREATE OR REPLACE TABLE ${p.table} AS SELECT * FROM ${reader}(?)`, [file]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }

    const now = ctx.now ?? new Date().toISOString();
    return {
      // the handle identifies what downstream SQL uses — the materialized table; the URL is provenance, below
      result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: p.table, pointer: { uri: `table:${p.table}`, format: "table" }, address: { algorithm: "sha256", digest } },
      sourceSnapshots: [{ source: p.url, retrievedAt: now, version: `sha256:${digest}` }],
      provenance: [{ source: p.url, retrievedAt: now, digest: `sha256:${digest}`, notes: ["http.get"] }],
    };
  };
}
