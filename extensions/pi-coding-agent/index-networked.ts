import { createBioExtension } from "./index.js";
import { cappedFetchLike } from "../../src/hosts/network.js";
export { cappedFetchLike, DEFAULT_MAX_RESPONSE_BYTES } from "../../src/hosts/network.js";

// The EXPLICIT networked entrypoint. Loading this file (`pi -e extensions/pi-coding-agent/index-networked.ts`)
// is the operator's visible, auditable grant of the network capability — composed in, not read from ambient
// env. The agent can never select this for itself; the human who launches Pi does. Everything else is identical
// to the default extension; the only difference is that a fetch is injected, so the http.get resolver binds.
//
// This thin entrypoint is the ONLY place the global fetch is selected implicitly for Pi. The shared host adapter
// shapes the runtime Response into the library's minimal FetchLike contract and applies a response byte cap. To
// enforce a tighter/other egress policy (allowlist,
// block internal-metadata IPs, timeouts, a smaller cap), wrap or replace this fetch — that policy is the host's,
// by design, since the library is not the network sandbox.

export default createBioExtension({ network: { fetch: cappedFetchLike() } });
