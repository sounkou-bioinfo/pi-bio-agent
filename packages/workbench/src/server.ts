import { serve, type ServerType } from "@hono/node-server";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createClinicalWorkbenchAddon, createWorkbenchApi } from "./api/app.js";
import { createArtifactWorkbenchAddon } from "./artifact-addon.js";
import { createPiAgentHost } from "./pi-agent-host.js";
import { loadHostGroundingRuntime } from "./grounding-host.js";
import { localMonarchFixtureRuntime } from "./monarch-host.js";
import { localCandidateVariantSearchRuntime } from "./candidate-variant-search.js";
import { defaultVepAnnotationRuntime } from "./clinical-genomics.js";

export async function startWorkbenchServer(workspaceArg = "examples/clinical-genomics", portArg = "8787", groundingModule?: string): Promise<ServerType> {
  const workspace = resolve(workspaceArg);
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535");

  const grounding = await loadHostGroundingRuntime(workspace, groundingModule);
  const agentHost = createPiAgentHost({
    cwd: workspace,
    extensionPaths: [fileURLToPath(import.meta.resolve("pi-bio-agent/pi-extension"))],
  });
  const addons = [createClinicalWorkbenchAddon({
    clinicalWorkspace: workspace,
    grounding,
    hypotheses: localMonarchFixtureRuntime(workspace),
    variantSearch: localCandidateVariantSearchRuntime(workspace),
    vep: defaultVepAnnotationRuntime(),
  }), createArtifactWorkbenchAddon(workspace)];
  const app = createWorkbenchApi({ agentHost, addons });

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  const [html, javascript, css, addonRuntime, clinicalEvidenceAddon, artifactsAddon] = await Promise.all([
    fs.readFile(join(webRoot, "index.html"), "utf8"),
    fs.readFile(join(webRoot, "app.js"), "utf8"),
    fs.readFile(join(webRoot, "styles.css"), "utf8"),
    fs.readFile(join(webRoot, "addon-runtime.js"), "utf8"),
    fs.readFile(join(webRoot, "addons", "clinical-evidence.js"), "utf8"),
    fs.readFile(join(webRoot, "addons", "artifacts.js"), "utf8"),
  ]);
  app.get("/", (context) => context.html(html));
  app.get("/app.js", (context) => context.body(javascript, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/styles.css", (context) => context.body(css, 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/addon-runtime.js", (context) => context.body(addonRuntime, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/addons/clinical-evidence.js", (context) => context.body(clinicalEvidenceAddon, 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/addons/artifacts.js", (context) => context.body(artifactsAddon, 200, { "content-type": "text/javascript; charset=utf-8" }));

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`pi-bio-workbench listening on http://127.0.0.1:${info.port}`);
    console.log(`OpenAPI: http://127.0.0.1:${info.port}/openapi.json`);
  });
  server.on("close", () => { void agentHost.dispose(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startWorkbenchServer(process.argv[2], process.argv[3], process.argv[4]);
}
