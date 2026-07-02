import { createBioExtension } from "./index.js";
import type { FetchLike } from "../../src/duckdb/resolvers/http-table-scan.js";
import { readCapped } from "../../src/duckdb/resolvers/http-stream.js";

/** Default response byte cap for the built-in networked adapter: a runaway/unbounded remote body can't exhaust
 *  process memory. Generous (whole-object materialization is legitimate — an API dump); a host that wants a
 *  tighter or per-endpoint policy wraps its own fetch. */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024; // 256 MiB

// The EXPLICIT networked entrypoint. Loading this file (`pi -e extensions/pi-coding-agent/index-networked.ts`)
// is the operator's visible, auditable grant of the network capability — composed in, not read from ambient
// env. The agent can never select this for itself; the human who launches Pi does. Everything else is identical
// to the default extension; the only difference is that a fetch is injected, so the http.get resolver binds.
//
// This thin adapter is the ONLY place the global fetch is touched. It shapes the runtime Response into the
// library's minimal FetchLike contract (ok/status/text/headers.get) and applies a DEFAULT response byte cap
// (readCapped) so a runaway body can't OOM the process. To enforce a tighter/other egress policy (allowlist,
// block internal-metadata IPs, timeouts, a smaller cap), wrap or replace this fetch — that policy is the host's,
// by design, since the library is not the network sandbox.
/** Shape a WHATWG fetch into the library's FetchLike, byte-CAPPING the response body via readCapped so an
 *  unbounded/runaway response cannot exhaust memory. Exported with an injectable fetch + cap so the bound is
 *  testable without touching globals. When the runtime exposes a body stream we read it capped; otherwise we fall
 *  back to text() (a mock/older runtime). A host wanting a tighter policy wraps its own fetch — this is the safe default. */
export function cappedFetchLike(fetchImpl: typeof globalThis.fetch = globalThis.fetch, maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES): FetchLike {
  return async (url, init) => {
    const res = await fetchImpl(url, init as RequestInit);
    return {
      ok: res.ok,
      status: res.status,
      text: () => (res.body ? readCapped(res.body, maxBytes) : res.text()),
      headers: { get: (n) => res.headers.get(n) },
    };
  };
}

export default createBioExtension({ network: { fetch: cappedFetchLike() } });
