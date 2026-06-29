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
  };
}
