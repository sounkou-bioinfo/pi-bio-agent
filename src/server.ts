import { serve, type ServerType } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWorkbenchApi } from "./api/app.js";
import { loadHostGroundingRuntime } from "./grounding-host.js";
import { localMonarchFixtureRuntime } from "./monarch-host.js";
import { localCandidateVariantSearchRuntime } from "./candidate-variant-search.js";

export async function startWorkbenchServer(workspaceArg = "examples/clinical-genomics", portArg = "8787", groundingModule?: string): Promise<ServerType> {
  const workspace = resolve(workspaceArg);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");

  const grounding = await loadHostGroundingRuntime(workspace, groundingModule);
  const app = createWorkbenchApi({
    clinicalWorkspace: workspace,
    grounding,
    hypotheses: localMonarchFixtureRuntime(workspace),
    variantSearch: localCandidateVariantSearchRuntime(workspace),
  });
  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`pi-bio-workbench listening on http://localhost:${info.port}`);
    console.log(`OpenAPI: http://localhost:${info.port}/openapi.json`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startWorkbenchServer(process.argv[2], process.argv[3], process.argv[4]);
}
