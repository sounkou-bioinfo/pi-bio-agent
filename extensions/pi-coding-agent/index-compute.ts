import { join } from "node:path";
import { createBioExtension } from "./index.js";
import { nodeProcessRunner } from "../../src/hosts/index.js";
import { fsCasStore } from "../../src/hosts/fs-cas.js";

// The EXPLICIT out-of-process COMPUTE entrypoint. Loading this file grants `process.compute` by injecting a
// `ProcessRunner` (spawns R / Python / Go / shell) plus a CAS so the compute's declared FILE outputs are captured
// by digest. Same visible, composed-in grant model as index-networked's fetch; the agent can never select it, the
// operator who launches Pi does.
export default createBioExtension({
  process: { runner: nodeProcessRunner() },
  cas: fsCasStore(join(process.cwd(), ".pi", "bio-agent", "cas")),
});
