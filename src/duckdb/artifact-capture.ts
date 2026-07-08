import { promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import type { CasStore } from "../core/cas.js";

// Capture DECLARED FILE OUTPUTS of an out-of-process computation into CAS, content-addressed — the #3 artifact
// transport (the nf-r-ipc/Nextflow split: VALUES return via Arrow, FILES go via CAS, never through the IPC). This
// is a SHARED host-side invariant, factored out of compute-run so any future compute adapter (a JobRunner /
// SLURM / NNG / container backend that owns a work dir) captures files under the EXACT SAME safety rules instead
// of reimplementing them subtly differently: relative-only paths, reject a symlink or a non-regular file, confirm
// the REALPATH stays inside the work dir (a child's `ln -s /etc/passwd out.txt` resolves lexically inside dir but
// realpaths out), optionally enforce a host quota, then stream the file into CAS.
//
// Lives at the duckdb layer (not hosts): the layer order here is hosts → duckdb → core, so a duckdb resolver
// (compute-run) must not import UP into hosts; a hosts adapter reaches DOWN into duckdb (the allowed edge).
// It depends only on core (CasStore) + node builtins.

/** A file a computation promises to write into its work dir. `path` is RELATIVE to that dir. */
export interface DeclaredOutput {
  name: string;
  path: string;
  kind?: string; // "file" | "table" | … (opaque here; carried through to the artifact record)
  mediaType?: string;
  semanticRole?: string;
  attrs?: Record<string, unknown>;
}

/** A captured artifact: the declared identity plus its CAS content address + size. */
export interface CapturedArtifact {
  name: string;
  path: string;
  kind: string;
  digest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  semanticRole?: string;
  attrs?: Record<string, unknown>;
}

/**
 * Capture each declared output from `workDir` into `cas`, fail-closed. A missing declared output is a failure (a
 * clean exit that skipped a promised file is still a failure). Throws on the FIRST violation; captures are
 * idempotent (same bytes → same digest), so a partial run leaves only already-addressed content in CAS.
 */
export async function captureDeclaredOutputsToCas(opts: {
  workDir: string;
  outputs: readonly DeclaredOutput[];
  cas: CasStore;
  /** Optional host quota. Omitted means no library-imposed artifact-size ceiling; capture still streams to CAS. */
  maxOutputBytes?: number;
  /** message prefix / actor for errors (default "compute.run" — preserves the resolver's error identity). */
  label?: string;
}): Promise<CapturedArtifact[]> {
  const { workDir, outputs, cas, maxOutputBytes } = opts;
  const label = opts.label ?? "compute.run";
  const artifacts: CapturedArtifact[] = [];
  const dirRoot = resolve(workDir);
  // the work dir itself may sit under a symlinked tmp (e.g. macOS /tmp -> /private/tmp), so the containment check
  // must compare REALPATHS, not the lexical path — realpath the root once.
  const realDirRoot = await fs.realpath(dirRoot);
  for (const o of outputs) {
    // lexical containment catches `..` traversal; the realpath check below catches a symlink the child created.
    const full = resolve(workDir, o.path);
    if (full !== dirRoot && !full.startsWith(dirRoot + sep)) throw new Error(`${label}: declared output '${o.name}' resolved outside the work dir`);
    let st;
    try { st = await fs.lstat(full); }
    catch { throw new Error(`${label}: declared output '${o.name}' (${o.path}) was not written (a clean exit that skipped a promised file is still a failure)`); }
    if (st.isSymbolicLink()) throw new Error(`${label}: declared output '${o.name}' must not be a symlink`);
    if (!st.isFile()) throw new Error(`${label}: declared output '${o.name}' must be a regular file`);
    if (maxOutputBytes !== undefined && st.size > maxOutputBytes) throw new Error(`${label}: declared output '${o.name}' is ${st.size} bytes, over the ${maxOutputBytes}-byte quota`);
    const real = await fs.realpath(full);
    if (real !== realDirRoot && !real.startsWith(realDirRoot + sep)) throw new Error(`${label}: declared output '${o.name}' realpath escaped the work dir`);
    const stored = await cas.putFile(real); // immutable + idempotent; streams, does not read the whole file into JS memory
    if (maxOutputBytes !== undefined && stored.size > maxOutputBytes) throw new Error(`${label}: declared output '${o.name}' captured ${stored.size} bytes, over the ${maxOutputBytes}-byte quota`);
    artifacts.push({
      name: o.name,
      path: o.path,
      kind: o.kind ?? "file",
      digest: `${stored.address.algorithm}:${stored.address.digest}` as `sha256:${string}`,
      size: stored.size,
      ...(o.mediaType !== undefined ? { mediaType: o.mediaType } : {}),
      ...(o.semanticRole !== undefined ? { semanticRole: o.semanticRole } : {}),
      ...(o.attrs !== undefined ? { attrs: o.attrs } : {}),
    });
  }
  return artifacts;
}
