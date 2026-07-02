import type { FetchLike } from "./http-table-scan.js";

// Production-semantics for http.get as COMPOSABLE host policies over the injected fetch — the host wraps its
// fetch with these before binding it (like network is composed in index-networked.ts); the resolver stays
// simple and the agent can never set them. Each is FetchLike -> FetchLike, so they compose:
//   withRetry(withAuth(fetch, getToken), { maxRetries: 4 })

/** Host-injected AUTH: merge host-owned auth headers into every request. `getAuthHeaders` is called PER REQUEST,
 *  so a host can refresh an expiring token (e.g. from pi's auth storage) transparently. Secrets never live in
 *  the manifest; auth wins over any manifest-supplied header of the same name. */
export function withAuth(fetchImpl: FetchLike, getAuthHeaders: () => Promise<Record<string, string>> | Record<string, string>): FetchLike {
  return async (url, init) => {
    const auth = await getAuthHeaders();
    // HTTP header names are CASE-INSENSITIVE, but a plain object spread is not: `{...{authorization:x}, Authorization:y}`
    // would send BOTH, and a server may prefer the caller's. So drop any request header that case-insensitively
    // collides with an auth header, THEN apply auth — host auth authoritatively wins (secrets never overridden).
    const authLower = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
    const base = Object.fromEntries(Object.entries(init?.headers ?? {}).filter(([k]) => !authLower.has(k.toLowerCase())));
    return fetchImpl(url, { ...init, headers: { ...base, ...auth } });
  };
}

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Hard cap on any single backoff wait, incl. a server-supplied `Retry-After` (default 60s). Without it a hostile
   *  or misconfigured `Retry-After: 31536000` would park a tool call for a YEAR. */
  maxDelayMs?: number;
  /** Injectable for deterministic tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** Sleep that also resolves the instant `signal` aborts — so an aborted tool call stops waiting out the backoff
 *  instead of hanging for the full (possibly huge) delay. The underlying timer is harmless if it fires later. */
function abortableSleep(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(ms).then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
  });
}

/** RATE-LIMIT handling: retry on 429 / 503 with exponential backoff, honoring `Retry-After` (seconds or an
 *  HTTP-date) when present but CAPPED at maxDelayMs. Bounded by maxRetries; other statuses pass straight through.
 *  Cancellable via the request's AbortSignal — a pre-aborted signal stops further retries, and an abort DURING a
 *  backoff wait ends the wait immediately (no year-long hang). */
export function withRetry(fetchImpl: FetchLike, opts: RetryOpts = {}): FetchLike {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (url, init) => {
    let attempt = 0;
    for (;;) {
      const res = await fetchImpl(url, init);
      const retryable = res.status === 429 || res.status === 503;
      if (!retryable || attempt >= maxRetries || init?.signal?.aborted) return res;
      const delay = Math.min(retryAfterMs(res.headers?.get("retry-after")) ?? baseDelayMs * 2 ** attempt, maxDelayMs);
      attempt++;
      await abortableSleep(delay, sleep, init?.signal);
      if (init?.signal?.aborted) return res; // aborted during backoff -> stop retrying, surface the last response
    }
  };
}

/** Parse a Retry-After header: a number of seconds, or an HTTP-date. Returns ms, or undefined if absent/bad. */
function retryAfterMs(header: string | null | undefined): number | undefined {
  if (header == null || header === "") return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}
