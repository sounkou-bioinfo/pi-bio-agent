// Bounded streaming read — the byte-cap half of pal #4 (cancellation + bounds). Reads a response body stream up
// to `maxBytes` and ABORTS beyond it, so a runaway/huge response cannot exhaust memory. The host's fetch adapter
// uses this instead of `response.text()` when a cap is set. It returns the RAW decoded bytes — there is NO SSE
// frame parser here: parsing `data:` frames off a text/event-stream is a SEPARATE layer NOT yet in-tree (the
// pi-mono patterns, github.com/badlogic/pi-mono, are the reference for when it lands); bidirectional/push is wss
// over nng / ducknng. See docs/refinments.md "Streaming transports".

async function* asAsyncIterable(src: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in src) { yield* src as AsyncIterable<Uint8Array>; return; }
  const reader = (src as ReadableStream<Uint8Array>).getReader();
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { drained = true; return; }
      if (value) yield value;
    }
  } finally {
    // If the consumer abandoned us EARLY (cap exceeded -> readCapped throws -> the for-await calls .return()), CANCEL
    // the body so the underlying fetch/connection stops downloading — releaseLock alone would leave it draining in
    // the background. cancel() also releases the lock, so only releaseLock on a fully-drained stream.
    if (drained) reader.releaseLock();
    else { try { await reader.cancel(); } catch { /* already errored/closed */ } }
  }
}

/** Read a byte stream into a string, throwing if it exceeds `maxBytes` (counted on the raw bytes, not the decoded
 *  text). Accepts a WHATWG ReadableStream (the runtime `fetch` body) or any async iterable of chunks. */
export async function readCapped(stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  for await (const chunk of asAsyncIterable(stream)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`http response exceeded byte cap of ${maxBytes} bytes`);
    out += decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}
