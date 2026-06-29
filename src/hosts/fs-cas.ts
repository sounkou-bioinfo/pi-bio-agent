import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CasStore } from "../core/cas.js";
import type { ContentAddress } from "../core/resources.js";

// Filesystem CAS rooted at a host-chosen directory (e.g. .pi/bio-agent/cas, or a shared cross-project cache, or
// an object-store mount). Layout: <root>/<algorithm>/<digest>. The host owns WHERE the store lives — the library
// only addresses by hash, so swapping a project-local store for a shared one is a host composition choice, not a
// code change. This is the host's fs adapter boundary (direct fs is allowed here, like run-store).
export function fsCasStore(root: string): CasStore {
  const pathFor = (a: ContentAddress): string => join(root, a.algorithm, a.digest);
  return {
    pathFor,
    async has(a) {
      try { await fs.access(pathFor(a)); return true; } catch { return false; }
    },
    async put(a, bytes) {
      // CAS must never store content that does not match its address, or a receipt's digest would lie. Verify
      // the bytes actually hash to the claimed address before writing (content-addressing is the whole point).
      if (a.algorithm === "sha256") {
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== a.digest) throw new Error(`CAS put: bytes hash to ${actual} but address claims ${a.digest} — refusing to store mismatched content`);
      }
      const dest = pathFor(a);
      try { await fs.access(dest); return; } catch { /* not present — write it */ }
      await fs.mkdir(join(root, a.algorithm), { recursive: true });
      // write to a unique temp then atomically rename, so a concurrent reader never sees a partial file
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, bytes);
      try {
        await fs.rename(tmp, dest);
      } catch (err) {
        // a racing put may have created dest first; immutable content means that's fine — drop our temp
        await fs.rm(tmp, { force: true });
        if (!(await this.has(a))) throw err;
      }
    },
    // Cross-db remote index: <root>/remote/<sha256(url)>.json. Keyed by URL hash (not the raw URL) so the
    // filename is path-safe regardless of the URL's characters.
    async getRemote(url) {
      const p = join(root, "remote", `${createHash("sha256").update(url).digest("hex")}.json`);
      try {
        const { etag, address } = JSON.parse(await fs.readFile(p, "utf8")) as { etag: string; address: ContentAddress };
        return { etag, address };
      } catch { return undefined; }
    },
    async putRemote(url, etag, address) {
      await fs.mkdir(join(root, "remote"), { recursive: true });
      const p = join(root, "remote", `${createHash("sha256").update(url).digest("hex")}.json`);
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify({ url, etag, address }));
      await fs.rename(tmp, p); // the validator is mutable (last-seen) — overwrite is correct
    },
  };
}
