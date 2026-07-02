import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withAuth, withRetry } from "../src/duckdb/resolvers/http-policies.js";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";

// The production-semantics resolutions, as composable host policies over fetch (host composes, agent can't).

describe("http policies: host-injected auth", () => {
  test("merges host auth headers per request (supports token refresh) and wins over manifest headers", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const base: FetchLike = async (_u, init) => { seen.push(init?.headers); return { ok: true, status: 200, text: async () => "[]" }; };
    let token = "tok-1";
    const fetchImpl = withAuth(base, () => ({ Authorization: `Bearer ${token}` }));

    await fetchImpl("https://x/y", { headers: { Accept: "application/json", Authorization: "manifest-should-not-win" } });
    assert.equal(seen[0]!.Authorization, "Bearer tok-1", "host auth wins over a manifest-supplied header");
    assert.equal(seen[0]!.Accept, "application/json", "non-auth manifest headers are preserved");

    token = "tok-2"; // the host refreshed the token
    await fetchImpl("https://x/y", {});
    assert.equal(seen[1]!.Authorization, "Bearer tok-2", "getAuthHeaders is called per request (refresh)");
  });

  test("SECURITY: host auth wins over a CASE-INSENSITIVELY colliding request header (no duplicate sent)", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const base: FetchLike = async (_u, init) => { seen.push(init?.headers); return { ok: true, status: 200, text: async () => "[]" }; };
    const fetchImpl = withAuth(base, () => ({ Authorization: "Bearer host" }));
    // the caller supplies a LOWERCASE 'authorization' — a plain spread would send BOTH; host auth must win, alone
    await fetchImpl("https://x/y", { headers: { authorization: "Bearer attacker", Accept: "application/json" } });
    const h = seen[0]!;
    assert.equal(h.Authorization, "Bearer host", "the host's Authorization is sent");
    assert.equal(h.authorization, undefined, "the case-colliding attacker header is DROPPED, not also sent");
    assert.equal(h.Accept, "application/json", "unrelated headers are preserved");
  });
});

describe("http policies: rate-limit backoff", () => {
  test("retries 429 honoring Retry-After, then succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const base: FetchLike = async () => {
      calls++;
      if (calls <= 2) return { ok: false, status: 429, text: async () => "", headers: { get: (n) => (n.toLowerCase() === "retry-after" ? "0" : null) } };
      return { ok: true, status: 200, text: async () => "ok" };
    };
    const fetchImpl = withRetry(base, { maxRetries: 4, sleep: async (ms) => { delays.push(ms); } });
    const res = await fetchImpl("https://x/y", {});
    assert.equal(res.status, 200);
    assert.equal(calls, 3, "two 429s then a 200");
    assert.deepEqual(delays, [0, 0], "honored Retry-After: 0 on both retries");
  });

  test("gives up after maxRetries and returns the last 429; exponential backoff when no Retry-After", async () => {
    const delays: number[] = [];
    const base: FetchLike = async () => ({ ok: false, status: 429, text: async () => "" }); // no Retry-After header
    const fetchImpl = withRetry(base, { maxRetries: 3, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
    const res = await fetchImpl("https://x/y", {});
    assert.equal(res.status, 429);
    assert.deepEqual(delays, [100, 200, 400], "exponential backoff: base * 2^attempt");
  });

  test("non-retryable statuses pass straight through; an aborted signal stops retrying", async () => {
    let calls = 0;
    const ok: FetchLike = async () => { calls++; return { ok: true, status: 404, text: async () => "" }; };
    assert.equal((await withRetry(ok)("https://x/y", {})).status, 404);
    assert.equal(calls, 1, "404 is not retried");

    const ac = new AbortController(); ac.abort();
    let n = 0;
    const limited: FetchLike = async () => { n++; return { ok: false, status: 429, text: async () => "" }; };
    await withRetry(limited, { sleep: async () => {} })("https://x/y", { signal: ac.signal });
    assert.equal(n, 1, "an already-aborted request is not retried");
  });

  test("SECURITY: a huge Retry-After is CAPPED at maxDelayMs (no year-long hang)", async () => {
    const delays: number[] = [];
    const base: FetchLike = async () => ({ ok: false, status: 503, text: async () => "", headers: { get: (h) => (h.toLowerCase() === "retry-after" ? "31536000" : null) } }); // 1 year (seconds)
    await withRetry(base, { maxRetries: 1, maxDelayMs: 1000, sleep: async (ms) => { delays.push(ms); } })("https://x/y", {});
    assert.deepEqual(delays, [1000], "a year-long Retry-After is clamped to maxDelayMs");
  });

  test("an abort DURING backoff ends the wait immediately and stops retrying", async () => {
    const ac = new AbortController();
    let calls = 0;
    const base: FetchLike = async () => { calls++; return { ok: false, status: 429, text: async () => "" }; };
    // a 'sleep' that never resolves on its own — only the abort race can end the wait
    const neverSleep = () => new Promise<void>(() => {});
    const p = withRetry(base, { maxRetries: 5, sleep: neverSleep })("https://x/y", { signal: ac.signal });
    queueMicrotask(() => ac.abort()); // abort while parked in backoff
    const res = await p;
    assert.equal(res.status, 429, "surfaced the last response after the abort");
    assert.equal(calls, 1, "did not fire further retries after the abort during backoff");
  });
});
