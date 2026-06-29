import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readCapped } from "../src/duckdb/resolvers/http-stream.js";

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
});
