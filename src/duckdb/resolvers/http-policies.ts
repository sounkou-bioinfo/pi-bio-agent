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
    return fetchImpl(url, { ...init, headers: { ...(init?.headers ?? {}), ...auth } });
  };
}

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injectable for deterministic tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** RATE-LIMIT handling: retry on 429 / 503 with exponential backoff, honoring `Retry-After` (seconds or an
 *  HTTP-date) when present. Bounded by maxRetries; other statuses pass straight through. Cancellable via the
 *  request's AbortSignal (a pre-aborted signal stops further retries). */
export function withRetry(fetchImpl: FetchLike, opts: RetryOpts = {}): FetchLike {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return async (url, init) => {
    let attempt = 0;
    for (;;) {
      const res = await fetchImpl(url, init);
      const retryable = res.status === 429 || res.status === 503;
      if (!retryable || attempt >= maxRetries || init?.signal?.aborted) return res;
      const delay = retryAfterMs(res.headers?.get("retry-after")) ?? baseDelayMs * 2 ** attempt;
      attempt++;
      await sleep(delay);
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
