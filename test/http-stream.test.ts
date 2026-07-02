import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readCapped } from "../src/duckdb/resolvers/http-stream.js";
import { cappedFetchLike } from "../extensions/pi-coding-agent/index-networked.js";

const enc = (s: string) => new TextEncoder().encode(s);
async function* chunks(...parts: string[]) { for (const p of parts) yield enc(p); }
function readableOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc(p)); c.close(); } });
}

describe("http-stream: bounded streaming read (byte cap)", () => {
  test("reads a stream under the cap (async iterable and ReadableStream)", async () => {
    assert.equal(await readCapped(chunks("hello ", "world"), 100), "hello world");
    assert.equal(await readCapped(readableOf("a", "b", "c"), 100), "abc");
  });

  test("throws when the stream exceeds the byte cap", async () => {
    await assert.rejects(() => readCapped(chunks("12345", "67890", "X"), 8), /exceeded byte cap of 8/);
  });

  test("CANCELS the underlying stream when the cap is exceeded (no background download)", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc("12345")); c.enqueue(enc("67890")); c.enqueue(enc("X")); /* deliberately not closed */ },
      cancel() { cancelled = true; },
    });
    await assert.rejects(() => readCapped(stream, 8), /exceeded byte cap/);
    await new Promise((r) => setTimeout(r, 0)); // let the finally's async cancel settle
    assert.equal(cancelled, true, "the body stream was cancelled, not left draining in the background");
  });
});

describe("cappedFetchLike: the default networked adapter enforces the byte cap on text()", () => {
  // a fake WHATWG fetch whose Response exposes a body stream (like the real runtime)
  const fakeFetch = (parts: string[]): typeof globalThis.fetch =>
    (async () => ({ ok: true, status: 200, body: readableOf(...parts), headers: { get: () => null } })) as unknown as typeof globalThis.fetch;

  test("a body under the cap is returned via text()", async () => {
    const f = cappedFetchLike(fakeFetch(["ab", "cd"]), 100);
    assert.equal(await (await f("https://x/")).text(), "abcd");
  });

  test("SECURITY: a body OVER the cap throws instead of buffering it all (no OOM on a runaway response)", async () => {
    const f = cappedFetchLike(fakeFetch(["12345", "67890", "X"]), 8);
    await assert.rejects(async () => (await f("https://x/")).text(), /exceeded byte cap of 8/);
  });

  test("falls back to text() when the runtime exposes no body stream (a mock/older runtime)", async () => {
    const noBody = (async () => ({ ok: true, status: 200, text: async () => "plain", headers: { get: () => null } })) as unknown as typeof globalThis.fetch;
    assert.equal(await (await cappedFetchLike(noBody, 4)("https://x/")).text(), "plain");
  });
});
