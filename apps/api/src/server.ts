import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { ScienceRuntime } from "./science/client.js";

const host = process.env.PI_BIO_HOST?.trim() || "127.0.0.1";
const port = parsePort(process.env.PI_BIO_PORT);
const dataDir = resolve(process.env.PI_BIO_DATA_DIR?.trim() || join(homedir(), ".pi", "bio"));
const webDir = resolve(
  process.env.PI_BIO_WEB_DIR?.trim() ||
    fileURLToPath(new URL("../../web/dist", import.meta.url)),
);
const apiToken = process.env.PI_BIO_API_TOKEN?.trim();

if (!isLoopback(host) && !apiToken) {
  throw new Error("PI_BIO_API_TOKEN is required when PI_BIO_HOST is not loopback");
}

const science = new ScienceRuntime({ databasePath: join(dataDir, "science.duckdb") });
const agents = await AgentService.create({ dataDir, science });
const app = createApp({
  agents,
  science,
  webDir,
  ...(apiToken === undefined ? {} : { apiToken }),
});
const server = serve({ fetch: app.fetch, hostname: host, port });
if (!server.listening) await once(server, "listening");
const address = server.address();
const actualPort = typeof address === "object" && address !== null ? address.port : port;

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    host,
    port: actualPort,
    dataDir,
    model: agents.modelIdentity,
    instanceId: randomUUID(),
  })}\n`,
);

let closing = false;
async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  await agents.close();
  await science.close();
  if (signal !== "beforeExit") process.exit(0);
}

process.on("SIGINT", () => void close("SIGINT"));
process.on("SIGTERM", () => void close("SIGTERM"));
process.on("beforeExit", () => void close("beforeExit"));

function parsePort(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 4317;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("PI_BIO_PORT must be an integer from 0 through 65535");
  }
  return parsed;
}

function isLoopback(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
