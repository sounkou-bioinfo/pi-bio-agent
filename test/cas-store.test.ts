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
    await cas.put(addr, bytes); // re-putting the SAME (matching) bytes is a no-op (present entry left untouched)
    assert.equal(await fs.readFile(cas.pathFor(addr), "utf8"), bytes, "a present entry is immutable");
    assert.equal((await fs.stat(cas.pathFor(addr))).mtimeMs, firstMtime, "no rewrite on re-put");
  });

  test("put REFUSES content that does not hash to its address (provenance integrity)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(root);
    const addr = addressOf("the real bytes");
    // a digest that does not match the bytes must be rejected — CAS can't be allowed to store a lie
    await assert.rejects(() => cas.put(addr, "DIFFERENT bytes than the address claims"), /mismatched content/);
    assert.equal(await cas.has(addr), false, "nothing was stored");
  });

  test("put FAILS CLOSED on a non-sha256 address (CAS is sha256-only; an unverifiable blob the GC can't root is refused)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(root);
    // a non-sha256 address: the TYPE is sha256-only, but a legacy/hostile input could still arrive at runtime — the
    // store must fail closed rather than store an unverifiable blob the GC can't root. (cast past the narrowed type.)
    const addr = { algorithm: "sha512", digest: "0".repeat(128) } as unknown as ContentAddress;
    await assert.rejects(() => cas.put(addr, "some bytes"), /only sha256 is supported/);
    assert.equal(await cas.has(addr), false, "nothing was stored");
  });

  test("an uppercase-hex digest maps to the SAME bytes as lowercase (put verifies + has finds, no case-mismatch)", async () => {
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const digest = createHash("sha256").update("hello").digest("hex");
    await cas.put({ algorithm: "sha256", digest }, "hello");
    const upper: ContentAddress = { algorithm: "sha256", digest: digest.toUpperCase() };
    assert.equal(await cas.has(upper), true, "uppercase address finds the lowercase-stored bytes");
    await cas.put(upper, "hello"); // an uppercase address also VERIFIES (hex is case-agnostic), not a mismatch error
  });

  test("SECURITY: pathFor/remove refuse an address whose digest could escape the CAS root", async () => {
    const cas = fsCasStore(await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-")));
    const hostile = { algorithm: "sha256", digest: "../../../../etc/passwd" } as unknown as ContentAddress;
    assert.throws(() => cas.pathFor(hostile), /invalid content address/, "a path-segment digest is refused, not joined");
    await assert.rejects(() => cas.remove(hostile), /invalid content address/, "remove() can't rm outside the CAS root");
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
