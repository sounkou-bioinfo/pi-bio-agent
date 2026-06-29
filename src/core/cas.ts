import type { ContentAddress } from "./resources.js";

// CAS-of-bytes: a content-addressed byte store. The bytes a resolver materializes are written ONCE under their
// content hash and reused across dbs/projects — distinct from the per-db resolution memo (which replays a
// materialized TABLE within ONE db). The sha256 digests every resolver already computes (and stamps into
// ResourceHandle.address) ARE the keys; CAS is the layer those digests were already reaching toward.
//
// Injected as a host capability (like network), never ambient. Default absent = "fast mode": DuckDB scans the
// source directly, no byte snapshot. Present = "CAS mode": bytes are snapshotted for byte-perfect provenance +
// cross-db reuse. CAS is storage/dedup, NOT freshness — an ETag / content-digest still decides what is current;
// CAS only decides whether the current bytes must be re-fetched or are already on disk.
export interface CasStore {
  /** Absolute path where this address's bytes live (whether or not they exist yet) — what DuckDB scans FROM. */
  pathFor(address: ContentAddress): string;
  /** True iff bytes for this address are already stored. */
  has(address: ContentAddress): Promise<boolean>;
  /** Store bytes under their content address. Idempotent + immutable: a present entry is left untouched (the
   *  address IS the content, so re-putting identical bytes is a no-op). */
  put(address: ContentAddress, bytes: Buffer | string): Promise<void>;

  // Cross-db remote-fetch index. The per-db resolution memo lives in ONE database and replays a materialized
  // table; this index is global to the CAS root, so ANY db can do a conditional GET with the last-seen ETag for
  // a URL and, on 304, materialize from the CAS bytes WITHOUT re-downloading — even where the table never
  // persisted. CAS stays storage/dedup, not freshness: the server's 304 (against this ETag) is what proves the
  // bytes are still current.
  /** The validator (ETag) + content address last stored for a URL, if any. */
  getRemote(url: string): Promise<{ etag: string; address: ContentAddress } | undefined>;
  /** Record the validator + content address for a URL after a real fetch. */
  putRemote(url: string, etag: string, address: ContentAddress): Promise<void>;
}
