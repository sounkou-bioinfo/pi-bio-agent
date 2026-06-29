import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { ContentAddress } from "../src/core/resources.js";

// The CAS kernel: a content-addressed byte store. Bytes are written once under their sha256 and reused; the
// address IS the content, so the store is immutable and dedups by construction.
const addressOf = (bytes: string): ContentAddress => ({ algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex") });

describe("CAS-of-bytes: a content-addressed byte store", () => {
  test("put stores bytes under <root>/<algo>/<digest>; has + pathFor see them; content round-trips", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(root);
    const bytes = '[{"obo_id":"MONDO:0004979"}]';
    const addr = addressOf(bytes);

    assert.equal(await cas.has(addr), false);
    await cas.put(addr, bytes);
    assert.equal(await cas.has(addr), true);
    assert.equal(cas.pathFor(addr), join(root, "sha256", addr.digest));
    assert.equal(await fs.readFile(cas.pathFor(addr), "utf8"), bytes);
  });

  test("put is idempotent + immutable — re-putting the same address is a no-op, content unchanged", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(root);
    const bytes = "the same bytes";
    const addr = addressOf(bytes);
    await cas.put(addr, bytes);
    const firstMtime = (await fs.stat(cas.pathFor(addr))).mtimeMs;
    await cas.put(addr, "DIFFERENT bytes (ignored — the address pins the content)");
    assert.equal(await fs.readFile(cas.pathFor(addr), "utf8"), bytes, "a present entry is immutable");
    assert.equal((await fs.stat(cas.pathFor(addr))).mtimeMs, firstMtime, "no rewrite on re-put");
  });

  test("distinct content lands in distinct entries (dedup is by hash)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(root);
    const a = addressOf("alpha");
    const b = addressOf("beta");
    await cas.put(a, "alpha");
    await cas.put(b, "beta");
    assert.notEqual(cas.pathFor(a), cas.pathFor(b));
    assert.equal(await fs.readFile(cas.pathFor(a), "utf8"), "alpha");
    assert.equal(await fs.readFile(cas.pathFor(b), "utf8"), "beta");
  });
});
