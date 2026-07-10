import { serve, type ServerType } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWorkbenchApi } from "./api/app.js";

export function startWorkbenchServer(workspaceArg = "examples/clinical-genomics", portArg = "8787"): ServerType {
  const workspace = resolve(workspaceArg);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");

  const app = createWorkbenchApi({ clinicalWorkspace: workspace });
  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`pi-bio-workbench listening on http://localhost:${info.port}`);
    console.log(`OpenAPI: http://localhost:${info.port}/openapi.json`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorkbenchServer(process.argv[2], process.argv[3]);
}
