import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { CasStore } from "../core/cas.js";
import type { ContentAddress } from "../core/resources.js";
import { validateContentAddress } from "../core/storage.js";

// Filesystem CAS rooted at a host-chosen POSIX-like directory (e.g. .pi/bio-agent/cas, or a shared cross-project
// filesystem mount). Layout: <root>/<algorithm>/<digest>. The host owns WHERE the store lives — the library only
// addresses by hash, so swapping a project-local store for a shared one is a host composition choice, not a code
// change. This is the host's fs adapter boundary (direct fs is allowed here, like run-store).
//
// This implementation assumes POSIX-ish filesystem semantics: directory listing, atomic intra-directory rename,
// file mtime, and unlink (the GC in gc.ts relies on the same). An object store (S3/GCS) has none of those as
// stated (no atomic rename, different listing/mtime semantics) and needs a DIFFERENT CasStore implementation —
// do NOT point this one at an object-store mount.
//
// CAS is sha256-only: every resolver stamps a sha256 address, gc.ts's liveDigests roots by 64-hex digest, and
// put() (below) only verifies sha256. ContentAddressAlgorithm is the type `"sha256"` — so a non-sha256 address is
// a type error at the boundary, and put() still FAILS CLOSED at runtime on any that slips past (a legacy/hostile
// input), rather than store an unverified blob the GC then can't root (the real footgun). Widen when a second algorithm has a
// real producer + GC support, not before.
export function fsCasStore(root: string): CasStore {
  // VALIDATE before deriving a path: algorithm ∈ {sha256} and digest is 64 hex, so a hostile/legacy address with
  // path segments (`../…`) can never escape the CAS root — this guards has/put/remove/pathFor at one chokepoint.
  const pathFor = (a: ContentAddress): string => {
    const errs = validateContentAddress(a);
    if (errs.length) throw new Error(`fsCasStore: refusing an invalid content address (${errs.join("; ")})`);
    return join(root, a.algorithm, a.digest.toLowerCase()); // lowercase: match casPathForAddress + Node's lowercase sha256 output (uppercase-hex addresses map to the same bytes)
  };
  return {
    pathFor,
    async has(a) {
      try { await fs.access(pathFor(a)); return true; } catch { return false; }
    },
    async put(a, bytes) {
      // CAS must never store content that does not match its address, or a receipt's digest would lie. This store
      // verifies sha256 only; a non-sha256 address can't be verified here, so refuse it (fail closed) rather than
      // store an unverifiable blob that the sha256-shaped GC could neither root nor trust.
      if (a.algorithm !== "sha256") throw new Error(`CAS put: only sha256 is supported today (got '${a.algorithm}') — refusing to store an unverified address`);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== a.digest.toLowerCase()) throw new Error(`CAS put: bytes hash to ${actual} but address claims ${a.digest} — refusing to store mismatched content`); // case-insensitive: hex is case-agnostic
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
    async remove(a) {
      // the GC sweep's hand: reclaim the bytes for a proven-unreferenced address. Idempotent (force) — a
      // racing sweep / already-gone entry is fine. Only the GC, holding proof the address is unrooted+unleased,
      // should reach here; the store itself does not decide liveness.
      await fs.rm(pathFor(a), { force: true });
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
