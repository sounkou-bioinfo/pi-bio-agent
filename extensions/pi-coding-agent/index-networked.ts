import { createBioExtension } from "./index.js";
import type { FetchLike } from "../../src/duckdb/resolvers/http-table-scan.js";

// The EXPLICIT networked entrypoint. Loading this file (`pi -e extensions/pi-coding-agent/index-networked.ts`)
// is the operator's visible, auditable grant of the network capability — composed in, not read from ambient
// env. The agent can never select this for itself; the human who launches Pi does. Everything else is identical
// to the default extension; the only difference is that a fetch is injected, so the http.get resolver binds.
//
// This thin adapter is the ONLY place the global fetch is touched. It shapes the runtime Response into the
// library's minimal FetchLike contract (ok/status/text/headers.get). To enforce an egress policy (allowlist,
// block internal-metadata IPs, timeouts/byte caps), wrap or replace this fetch — that policy is the host's, by
// design, since the library is not the network sandbox.
const fetchLike: FetchLike = async (url, init) => {
  const res = await globalThis.fetch(url, init as RequestInit);
  return { ok: res.ok, status: res.status, text: () => res.text(), headers: { get: (n) => res.headers.get(n) } };
};

export default createBioExtension({ network: { fetch: fetchLike } });
