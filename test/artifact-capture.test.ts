import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CasStore } from "../src/core/cas.js";
import type { ContentAddress } from "../src/core/resources.js";
import { captureDeclaredOutputsToCas } from "../src/duckdb/artifact-capture.js";

// The shared file-artifact capture invariant, factored out of process-compute so future compute adapters
// (JobRunner / SLURM / NNG / container) inherit the SAME safety rules. These tests pin those rules directly,
// independent of the resolver: a regular file is captured; a symlink / non-regular / outside-realpath / oversized
// / missing output all fail closed.
function fakeCas(): CasStore & { puts: Array<{ digest: string; bytes: Buffer }> } {
  const puts: Array<{ digest: string; bytes: Buffer }> = [];
  return {
    puts,
    pathFor: (a: ContentAddress) => `/cas/${a.algorithm}/${a.digest}`,
    async has() { return false; },
    async put(a, bytes) { puts.push({ digest: a.digest, bytes: Buffer.from(bytes) }); },
    async remove() {},
    async getRemote() { return undefined; },
    async putRemote() {},
  };
}

async function workDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), "pi-bio-artcap-"));
}

describe("captureDeclaredOutputsToCas: shared file-artifact capture safety", () => {
  test("captures a regular file into CAS with digest + size", async () => {
    const dir = await workDir();
    await fs.writeFile(join(dir, "out.txt"), "hello");
    const cas = fakeCas();
    const arts = await captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "out.txt", kind: "file" }], cas, maxOutputBytes: 1024 });
    assert.equal(arts.length, 1);
    assert.equal(arts[0]!.size, 5);
    assert.match(arts[0]!.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(cas.puts.length, 1, "the bytes were put into CAS");
    assert.equal(cas.puts[0]!.bytes.toString(), "hello");
  });

  test("rejects a MISSING declared output (a clean exit that skipped a promised file is a failure)", async () => {
    const dir = await workDir();
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "nope.txt" }], cas: fakeCas(), maxOutputBytes: 1024 }), /was not written/);
  });

  test("SECURITY: rejects a SYMLINK output whose realpath escapes the work dir (no smuggling a host file into CAS)", async () => {
    const dir = await workDir();
    const secret = join(await workDir(), "secret.txt");
    await fs.writeFile(secret, "TOP SECRET");
    await fs.symlink(secret, join(dir, "out.txt")); // child: ln -s <outside secret> out.txt
    const cas = fakeCas();
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "out.txt" }], cas, maxOutputBytes: 1024 }), /must not be a symlink/);
    assert.equal(cas.puts.length, 0, "nothing was captured");
  });

  test("SECURITY: rejects a `..` path that resolves outside the work dir", async () => {
    const dir = await workDir();
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "../escape.txt" }], cas: fakeCas(), maxOutputBytes: 1024 }), /resolved outside the work dir/);
  });

  test("rejects a NON-REGULAR file (e.g. a directory declared as an output)", async () => {
    const dir = await workDir();
    await fs.mkdir(join(dir, "adir"));
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "adir" }], cas: fakeCas(), maxOutputBytes: 1024 }), /must be a regular file/);
  });

  test("enforces the byte cap BEFORE reading the file whole into memory", async () => {
    const dir = await workDir();
    await fs.writeFile(join(dir, "big.txt"), "0123456789"); // 10 bytes
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "big.txt" }], cas: fakeCas(), maxOutputBytes: 4 }), /over the 4-byte cap/);
  });

  test("a custom label prefixes the error (so a future adapter names itself)", async () => {
    const dir = await workDir();
    await assert.rejects(() => captureDeclaredOutputsToCas({ workDir: dir, outputs: [{ name: "o", path: "nope" }], cas: fakeCas(), maxOutputBytes: 16, label: "nngProcessRunner" }), /^Error: nngProcessRunner: /);
  });
});
