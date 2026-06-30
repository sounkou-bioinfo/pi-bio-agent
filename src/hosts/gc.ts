import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "./run-store.js";

// Garbage collection for the substrate's two unbounded stores: the CAS (content-addressed bytes) and the run
// directory. The model: the CAS is a HEAP; a run's receipts are its ROOTS; MARK-AND-SWEEP deletes CAS entries
// unreachable from a surviving run (safe because CAS is a cache + provenance snapshot, re-derivable on miss).
//
// *** DISTRIBUTED-RUN SAFETY (load-bearing) ***
// Mark-and-sweep is correct ONLY when the root set is COMPLETE. Two hazards once runs are distributed over a
// SHARED CAS (a shared filesystem mount / a ducknng-served shared db):
//   1. INCOMPLETE ROOTS: a GC on one node sees only ITS local runs. Sweeping from local roots alone would
//      delete bytes that ANOTHER node's runs still reference. => the caller MUST pass the union of ALL nodes'
//      roots (`extraRoots`, e.g. scanned from a ducknng-served run/receipt index) before sweeping a shared CAS.
//      Without that, restrict GC to a NODE-LOCAL CAS (the default, single-node case, which IS safe).
//   2. WRITE RACE: a concurrent/remote run can write CAS bytes that are not yet in any committed receipt. The
//      `minAgeMs` grace retains entries younger than the longest possible in-flight run, so they are never
//      swept out from under a writer.
// collectGarbage is single-node-safe by default; pass extraRoots + minAgeMs for the distributed case.

/** Every 64-hex content digest mentioned anywhere in these receipt JSON blobs — sourceSnapshot versions,
 *  provenance digests, result-handle addresses. These name the CAS files retained runs still reference.
 *  sha256-SHAPED by design (64 hex): the CAS is sha256-only today (fsCasStore.put refuses other algorithms), so
 *  a 64-hex scan IS the complete root set. If a second algorithm ever gets a producer, this must parse the
 *  structured address fields (algorithm+digest) instead — a bare-hex scan can't root a 128-hex sha512 digest. */
export function liveDigests(receiptJsons: string[]): Set<string> {
  const set = new Set<string>();
  for (const j of receiptJsons) for (const m of j.matchAll(/[0-9a-f]{64}/g)) set.add(m[0]);
  return set;
}

export interface CasGcResult { swept: string[]; retained: number; }

/** Mark-and-sweep the filesystem CAS: delete every `<root>/<algo>/<digest>` whose digest is not a live root AND
 *  is older than `minAgeMs` (the write-race grace — a too-new entry may be an in-flight/remote writer's bytes
 *  not yet in any receipt). `live` MUST be the COMPLETE root set (all nodes) for a shared CAS. The `remote/`
 *  index dir is left to `gcRemoteIndex`. */
export async function gcCas(casRoot: string, live: Set<string>, opts: { minAgeMs?: number; now?: number } = {}): Promise<CasGcResult> {
  const result: CasGcResult = { swept: [], retained: 0 };
  const minAgeMs = opts.minAgeMs ?? 0;
  const now = opts.now ?? Date.now();
  let algos: string[];
  try {
    algos = (await fs.readdir(casRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== "remote").map((d) => d.name);
  } catch { return result; } // no CAS root yet
  for (const algo of algos) {
    const dir = join(casRoot, algo);
    for (const name of await fs.readdir(dir)) {
      if (live.has(name)) { result.retained++; continue; }
      if (minAgeMs > 0) {
        const age = now - (await fs.stat(join(dir, name))).mtimeMs;
        if (age < minAgeMs) { result.retained++; continue; } // too new to safely sweep (a concurrent/remote writer)
      }
      await fs.rm(join(dir, name), { force: true });
      result.swept.push(`${algo}/${name}`);
    }
  }
  return result;
}

/** Drop CAS remote-index entries (`remote/<hash>.json`) whose stored address is no longer in the live set — a
 *  url->bytes pointer to swept content would 304-replay a gone artifact. Run AFTER gcCas: the cross-db cache is
 *  best-effort and SUBORDINATE to run-receipt roots (it does NOT contribute its own roots — self-rooting would
 *  pin its bytes forever, an unbounded cache; see cas.ts). So gcCas sweeps bytes by receipt roots, then this
 *  prunes the index entries whose bytes that sweep removed, leaving the index coherent (no dangling pointers).
 *  NOTE: coherent only for a NODE-LOCAL, non-concurrent GC. A GC that interleaves with a live 304-reuse on a
 *  SHARED CAS can still race (read the index, sweep the bytes, then materialize a gone path) — that race, like
 *  the rest of distributed-CAS GC, is the ducknng-fs/shared-CAS lane's job (refs/leases), not this sweeper's. */
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
 *  receipts. SINGLE-NODE-SAFE by default. For DISTRIBUTED runs over a SHARED CAS, pass `extraRoots` — the union
 *  of every OTHER node's live digests (e.g. scanned from a ducknng-served receipt index) — and `minAgeMs` (a grace
 *  >= the longest possible in-flight run) so a local sweep cannot delete another node's or an in-flight run's
 *  bytes. Without extraRoots, only run this against a node-LOCAL CAS. */
export async function collectGarbage(cwd: string, opts: { runs?: PruneOpts; casRoot?: string; extraRoots?: Iterable<string>; minAgeMs?: number } = {}): Promise<{ runsPruned: string[]; casSwept: string[]; remoteDropped: number }> {
  const runsDir = runsRoot(cwd);
  const { pruned, kept } = await pruneRuns(runsDir, opts.runs ?? {});
  const receiptJsons = await Promise.all(kept.map(async (name) => {
    try { return await fs.readFile(join(runsDir, name, "receipts.json"), "utf8"); } catch { return ""; }
  }));
  const live = liveDigests(receiptJsons);
  for (const r of opts.extraRoots ?? []) live.add(r); // cross-node roots: the union of all nodes' live digests
  const casRoot = opts.casRoot ?? join(cwd, ".pi", "bio-agent", "cas");
  const { swept } = await gcCas(casRoot, live, { minAgeMs: opts.minAgeMs });
  const { dropped } = await gcRemoteIndex(casRoot, live);
  return { runsPruned: pruned, casSwept: swept, remoteDropped: dropped };
}
