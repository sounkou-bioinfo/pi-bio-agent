import { createHash } from "node:crypto";
import { systemClock } from "../../core/clock.js";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BioResolverImpl, ResolverOutput } from "../../core/ports.js";
import { memoClear, memoGet, memoStore } from "../resolution-memo.js";

// ONE generic HTTP resolver — not a per-API client. It GETs a declared URL and materializes the response into
// a DuckDB table via a native reader (json/csv), so any HTTP/JSON source (OLS4 search, OpenTargets, gnomAD,
// an arbitrary REST endpoint) becomes queryable with the SAME operation SQL — the URL/shape are DATA in the
// manifest, never code. Network is INJECTED (the host passes a fetch impl), so there is no ambient network:
// `npm run check` binds a mock; a real host binds globalThis.fetch. It is NOT a default built-in — a manifest
// that declares it fails closed until a host explicitly binds it with a fetch, which is the network opt-in.
// Fail-closed: only http(s) URLs, non-2xx throws, no retry/fallback. The receipt stamps the URL + a sha256 of
// the exact bytes fetched, so the run records precisely what came back.

export type FetchResponse = { ok: boolean; status: number; text(): Promise<string>; headers?: { get(name: string): string | null } };
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<FetchResponse>;

// A remote resource is a time-varying thunk; its memo is HTTP cache validation, not a precomputed token. We
// store the response's ETag and replay the cached receipt on a `304 Not Modified` to a conditional
// `If-None-Match` — no body re-download, no re-materialize. Named consumers: ClawBio's Variant Annotation skill
// (repeated OpenTargets/gnomAD/ClinVar lookups) and metacurator's `disambiguate` (repeated OLS4 grounding).
// Correctness: ETag only (Last-Modified would need If-Modified-Since), and only when there are no custom request
// headers (Vary).

const READERS: Record<string, string> = { json: "read_json_auto", ndjson: "read_json_auto", csv: "read_csv_auto" };

/** Build the HTTP table resolver bound to a host-supplied fetch. Tests pass a mock; production passes fetch. */
export function httpTableResolver(fetchImpl: FetchLike): BioResolverImpl {
  return async (resource, ctx) => {
    const p = resource.params as { url?: unknown; table?: unknown; format?: unknown; method?: unknown; headers?: unknown; body?: unknown };
    if (typeof p.url !== "string" || !p.url.trim()) {
      throw new Error("http resolver requires params.url (a string: an http(s) URL, or a SQL expression that composes one)");
    }
    if (typeof p.table !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.table)) {
      throw new Error("http resolver requires params.table to be a valid SQL identifier");
    }
    // URL composition is SQL, not a bespoke template DSL: a literal http(s) URL is used as-is; otherwise `url` is
    // a SQL EXPRESSION evaluated against the conn — `getvariable('query')` for agent params (SET VARIABLE),
    // subqueries / string_agg over upstream tables for upstream data. DuckDB does the composition.
    let composedUrl: string = p.url;
    if (!/^https?:\/\//i.test(composedUrl)) {
      const rows = await ctx.conn.all<{ u: unknown }>(`SELECT (${composedUrl}) AS u`);
      composedUrl = String(rows[0]?.u ?? "");
      if (!/^https?:\/\//i.test(composedUrl)) throw new Error(`http resolver: the url expression composed '${composedUrl}', which is not an http(s) URL`);
    }
    const format = typeof p.format === "string" ? p.format : "json";
    const reader = READERS[format];
    if (!reader) throw new Error(`http resolver: unknown format '${format}' (expected json, ndjson, or csv)`);
    const headers = (p.headers && typeof p.headers === "object" ? p.headers : {}) as Record<string, string>;
    // SECURITY: a manifest is agent-authorable DATA, so it must not carry SECRETS. Use an ALLOWLIST of clearly
    // non-secret headers (a denylist can never be complete — Private-Token, Ocp-Apim-Subscription-Key, X-Foo-Auth,
    // … would slip through). Anything else — including any auth/custom header that might bear a secret — is refused
    // and must be injected by a host fetch policy (withAuth). Fail closed.
    const SAFE_MANIFEST_HEADERS = new Set(["accept", "accept-language", "accept-encoding", "content-type", "content-language", "user-agent", "referer", "if-none-match", "if-modified-since", "cache-control"]);
    for (const name of Object.keys(headers)) {
      if (!SAFE_MANIFEST_HEADERS.has(name.toLowerCase())) throw new Error(`http.get: header '${name}' is not allowed from a manifest — a manifest must not carry secrets. Only non-secret headers (Accept, Content-Type, …) are permitted; inject auth/custom headers via a host fetch policy (withAuth).`);
    }
    // This resolver materializes a response BODY into a table, so it allows the BODY-RETURNING READ methods:
    // GET, or POST as a QUERY (a body that READS — VEP batch, GraphQL). PUT/DELETE/PATCH (mutations) are refused.
    // HEAD/OPTIONS are also safe but return METADATA/capabilities, not a data body — they belong to API
    // DISCOVERY (alongside OpenAPI specs), a separate concern from data-fetch, not this body->table resolver.
    const method = p.method === undefined ? "GET" : String(p.method).toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("http.get supports GET or read-only POST (a query body); PUT/DELETE/PATCH are refused");
    const requestBody = method === "POST" && p.body !== undefined ? (typeof p.body === "string" ? p.body : JSON.stringify(p.body)) : undefined;
    // Capture the now-narrowed string values: TS drops property narrowing inside the closures below.
    const url: string = composedUrl;
    const table: string = p.table;

    // Memoize only when there are NO custom request headers — Accept/auth/etc. (Vary) could otherwise make a
    // 304 replay the wrong representation. Two layers of conditional-request reuse, both gated on `memoable`:
    //   per-db memo  → replays a materialized TABLE within THIS db (no re-materialize).
    //   CAS remote   → a cross-db url→{etag,address} index; lets a DIFFERENT db 304 and materialize from the
    //                  already-stored CAS bytes WITHOUT re-downloading. The per-db memo wins when both apply.
    const memoable = method === "GET" && Object.keys(headers).length === 0; // POST is body-dependent: skip the ETag/304 memo
    const cas = ctx.cas;
    const memo = memoable ? await memoGet(ctx.conn, table) : undefined;
    const sameUrl = memo?.receipt.sourceSnapshots[0]?.source === url;
    const casRemote = !memo && memoable && cas ? await cas.getRemote(url) : undefined;
    const validator = memo && sameUrl ? memo.freshness : casRemote?.etag;
    const conditional = validator !== undefined ? { ...headers, "If-None-Match": validator } : headers;
    const res = await fetchImpl(url, { method, headers: conditional, body: requestBody, signal: ctx.signal });

    const now = ctx.now ?? systemClock();
    const materializeFrom = (file: string) => ctx.conn.run(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${reader}(?)`, [file]);
    const outputFor = (digest: string): ResolverOutput => ({
      // the handle identifies what downstream SQL uses — the materialized table; the URL is provenance, below
      result: { mode: "reference", name: table, pointer: { uri: `table:${table}`, format: "table" }, address: { algorithm: "sha256", digest } },
      sourceSnapshots: [{ source: url, retrievedAt: now, version: `sha256:${digest}` }],
      provenance: [{ source: url, retrievedAt: now, digest: `sha256:${digest}`, notes: cas ? ["http.get", "cas"] : ["http.get"] }],
    });

    if (res.status === 304) {
      if (memo && sameUrl) return memo.receipt; // per-db: replay cached receipt, skip body + materialize
      if (casRemote && cas) {
        // cross-db: the unchanged bytes are already in CAS (a prior fetch put them) — materialize from them, no download
        await materializeFrom(cas.pathFor(casRemote.address));
        const output = outputFor(casRemote.address.digest);
        if (memoable) await memoStore(ctx.conn, table, casRemote.etag, output); // seed THIS db's memo
        return output;
      }
      throw new Error(`http resolver: GET ${url} returned 304 but no cached bytes were available to replay`);
    }
    if (!res.ok) throw new Error(`http resolver: GET ${url} returned status ${res.status}`); // fail closed, no retry/fallback

    const body = await res.text();
    const digest = createHash("sha256").update(body).digest("hex");
    const etag = res.headers?.get("etag") ?? undefined;

    // CAS mode: snapshot the bytes into the store and scan FROM the CAS path (byte-perfect provenance + cross-db
    // reuse). Fast mode: scan from a throwaway temp file. Either way this is resolver DDL (CREATE), not operation
    // SQL, so it never flows through the read-only guard.
    if (cas) {
      const address = { algorithm: "sha256" as const, digest };
      await cas.put(address, body);
      await materializeFrom(cas.pathFor(address));
      if (memoable && etag !== undefined) await cas.putRemote(url, etag, address); // seed the cross-db index
    } else {
      const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-http-"));
      const file = join(dir, format === "csv" ? "body.csv" : "body.json");
      await fs.writeFile(file, body, "utf8");
      try { await materializeFrom(file); } finally { await fs.rm(dir, { recursive: true, force: true }); }
    }

    const output = outputFor(digest);
    // Store the ETag if the server gave one; if a fresh 200 has NO validator, CLEAR any prior memo so a stale
    // validator can never be replayed on a later 304.
    if (memoable) {
      if (etag !== undefined) await memoStore(ctx.conn, table, etag, output);
      else await memoClear(ctx.conn, table);
    }
    return output;
  };
}
