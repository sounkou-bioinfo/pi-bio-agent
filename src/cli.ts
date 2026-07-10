#!/usr/bin/env node
import { resolve } from "node:path";
import { runClinicalGenomicsWorkbench } from "./clinical-genomics.js";
import { loadHostGroundingRuntime } from "./grounding-host.js";
import { startWorkbenchServer } from "./server.js";

const args = process.argv.slice(2);
const command = args[0] ?? "run";

if (command === "serve") {
  await startWorkbenchServer(args[1], args[2], args[3]);
} else if (command === "run") {
  const exampleDir = resolve(args[1] ?? "examples/clinical-genomics");
  const result = await runClinicalGenomicsWorkbench({
    exampleDir,
    caseId: args[2] ?? "CASE-RD-001",
    grounding: await loadHostGroundingRuntime(exampleDir, args[4]),
    ...(args[3] ? { analysisId: args[3] } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error("usage: pi-bio-workbench [run <workspace> <case-id> [analysis-id] [grounding-module] | serve <workspace> [port] [grounding-module]]");
}
