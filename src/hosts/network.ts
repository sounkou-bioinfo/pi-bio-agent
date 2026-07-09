import type { FetchLike } from "../duckdb/resolvers/http-table-scan.js";
import { readCapped } from "../duckdb/resolvers/http-stream.js";

/** Default memory bound for hosts that adapt WHATWG fetch directly into the `http.get` resolver. */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/** Adapt WHATWG fetch to the small injected network port while bounding response bytes before JSON materialization. */
export function cappedFetchLike(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): FetchLike {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("cappedFetchLike: maxBytes must be a positive safe integer");
  return async (url, init) => {
    const response = await fetchImpl(url, init as RequestInit);
    return {
      ok: response.ok,
      status: response.status,
      text: async () => {
        if (response.body) return readCapped(response.body, maxBytes);
        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`response body exceeds the ${maxBytes}-byte cap`);
        return text;
      },
      headers: { get: (name) => response.headers.get(name) },
    };
  };
}
