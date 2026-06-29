import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "./run-store.js";

// Garbage collection for the substrate's two unbounded stores: the CAS (content-addressed bytes) and the run
// directory. The model makes GC simple and SAFE:
//   - the CAS is a HEAP; a run's receipts are its ROOTS (every receipt records the digests it produced/used).
//   - a run-retention policy (keep last N / TTL) decides which runs survive.
//   - MARK-AND-SWEEP: any CAS entry not reachable from a SURVIVING run's receipts (or the CAS remote index) is
//     garbage. Deleting it is safe because CAS is a cache + provenance snapshot, not the source of truth — a
//     later resolve re-fetches on miss (the resolution memo / http.get ETag path).

/** Every 64-hex content digest mentioned anywhere in these receipt JSON blobs — sourceSnapshot versions,
 *  provenance digests, result-handle addresses. These name the CAS files retained runs still reference. */
export function liveDigests(receiptJsons: string[]): Set<string> {
  const set = new Set<string>();
  for (const j of receiptJsons) for (const m of j.matchAll(/[0-9a-f]{64}/g)) set.add(m[0]);
  return set;
}

export interface CasGcResult { swept: string[]; retained: number; }

/** Mark-and-sweep the filesystem CAS: delete every `<root>/<algo>/<digest>` whose digest is not a live root.
 *  The `remote/` index dir is left to `gcRemoteIndex`. */
export async function gcCas(casRoot: string, live: Set<string>): Promise<CasGcResult> {
  const result: CasGcResult = { swept: [], retained: 0 };
  let algos: string[];
  try {
    algos = (await fs.readdir(casRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "remote").map((d) => d.name);
  } catch { return result; } // no CAS root yet
  for (const algo of algos) {
    const dir = join(casRoot, algo);
    for (const name of await fs.readdir(dir)) {
      if (live.has(name)) { result.retained++; continue; }
      await fs.rm(join(dir, name), { force: true });
      result.swept.push(`${algo}/${name}`);
    }
  }
  return result;
}

/** Drop CAS remote-index entries (`remote/<hash>.json`) whose stored address is no longer in the live set — a
 *  url->bytes pointer to swept content would 304-replay a gone artifact. Also returns their addresses as roots. */
export async function gcRemoteIndex(casRoot: string, live: Set<string>): Promise<{ dropped: number }> {
  const dir = join(casRoot, "remote");
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return { dropped: 0 }; }
  let dropped = 0;
  for (const f of files) {
    try {
      const { address } = JSON.parse(await fs.readFile(join(dir, f), "utf8")) as { address?: { digest?: string } };
      if (!address?.digest || !live.has(address.digest)) { await fs.rm(join(dir, f), { force: true }); dropped++; }
    } catch { /* unreadable index entry — leave it */ }
  }
  return { dropped };
}

export interface PruneOpts {
  /** Keep at most this many most-recent runs. */
  keep?: number;
  /** Also prune runs older than this many ms. */
  olderThanMs?: number;
  /** Injectable clock for tests. */
  now?: number;
}

/** Prune run directories by retention policy (keep newest N and/or drop older-than-TTL), newest by mtime. */
export async function pruneRuns(runsDir: string, opts: PruneOpts = {}): Promise<{ pruned: string[]; kept: string[] }> {
  let entries: Array<{ name: string; mtime: number }>;
  try {
    const names = (await fs.readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    entries = await Promise.all(names.map(async (name) => ({ name, mtime: (await fs.stat(join(runsDir, name))).mtimeMs })));
  } catch { return { pruned: [], kept: [] }; }
  entries.sort((a, b) => b.mtime - a.mtime); // newest first
  const now = opts.now ?? Date.now();
  const pruned: string[] = [], kept: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const tooOld = opts.olderThanMs !== undefined && now - e.mtime > opts.olderThanMs;
    const overCount = opts.keep !== undefined && i >= opts.keep;
    if (tooOld || overCount) { await fs.rm(join(runsDir, e.name), { recursive: true, force: true }); pruned.push(e.name); }
    else kept.push(e.name);
  }
  return { pruned, kept };
}

/** End-to-end GC for a project: prune runs first, then mark-and-sweep the CAS rooted at the SURVIVING runs'
 *  receipts. Returns what was reclaimed. The CAS root is the host's choice (default `.pi/bio-agent/cas`). */
export async function collectGarbage(cwd: string, opts: { runs?: PruneOpts; casRoot?: string } = {}): Promise<{ runsPruned: string[]; casSwept: string[]; remoteDropped: number }> {
  const runsDir = runsRoot(cwd);
  const { pruned, kept } = await pruneRuns(runsDir, opts.runs ?? {});
  const receiptJsons = await Promise.all(kept.map(async (name) => {
    try { return await fs.readFile(join(runsDir, name, "receipts.json"), "utf8"); } catch { return ""; }
  }));
  const live = liveDigests(receiptJsons);
  const casRoot = opts.casRoot ?? join(cwd, ".pi", "bio-agent", "cas");
  const { swept } = await gcCas(casRoot, live);
  const { dropped } = await gcRemoteIndex(casRoot, live);
  return { runsPruned: pruned, casSwept: swept, remoteDropped: dropped };
}
