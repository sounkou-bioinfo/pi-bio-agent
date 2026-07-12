import { join } from "node:path";
import { createBioExtension } from "./index.js";
import { nodeComputeRunner } from "../../src/hosts/index.js";
import { fsCasStore } from "../../src/hosts/fs-cas.js";

// The EXPLICIT COMPUTE entrypoint. Loading this file grants `compute.run` by injecting a ComputeRunner
// (local implementation: node child process) plus a CAS so the compute's declared FILE outputs are captured
// by digest. Same visible, composed-in grant model as index-networked's fetch; the agent can never select it, the
// operator who launches Pi does.
export default createBioExtension({
  compute: { runner: nodeComputeRunner() },
  cas: (cwd) => fsCasStore(join(cwd, ".pi", "bio-agent", "cas")),
});
