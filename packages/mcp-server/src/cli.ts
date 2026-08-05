#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fsCasStore } from "pi-bio-agent";
import { createBioMcpHandler, type BioMcpPermissionProfile } from "./index.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

interface CliOptions {
  cwd: string;
  catalogRoot: string;
  casRoot: string;
  dbPath: string;
  host: string;
  port: number;
  profile: BioMcpPermissionProfile;
  legacyStateless: boolean;
}

const USAGE = `usage: pi-bio-mcp [options]

Options:
  --cwd <dir>                 host workspace (default: current directory)
  --catalog-root <dir>        manifest catalog beneath cwd (default: examples)
  --cas-root <dir>            CAS root (default: .pi/bio-agent/cas)
  --db <path|:memory:>        scientific database (default: :memory:)
  --host <address>            listen address (default: 127.0.0.1)
  --port <number>             listen port (default: 8765)
  --profile <name>            exploratory|operations-only|sealed-offline
  --legacy-stateless          deliberately serve 2025 requests per request
  --help                      show this message

The endpoint is /mcp. The final 2026-07-28 protocol is strict by default; no MCP session table is created.`;

function parseArgs(argv: string[]): CliOptions {
  const values: Record<string, string> = {};
  let legacyStateless = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--legacy-stateless") {
      legacyStateless = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument '${arg}'`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`flag --${key} requires a value`);
    values[key] = value;
    i += 1;
  }
  const profile = values.profile ?? "exploratory";
  if (profile !== "exploratory" && profile !== "operations-only" && profile !== "sealed-offline") {
    throw new Error("--profile must be exploratory, operations-only, or sealed-offline");
  }
  const port = Number(values.port ?? 8765);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  const cwd = resolve(values.cwd ?? process.cwd());
  return {
    cwd,
    catalogRoot: values["catalog-root"] ?? "examples",
    casRoot: resolve(cwd, values["cas-root"] ?? ".pi/bio-agent/cas"),
    dbPath: values.db ?? ":memory:",
    host: values.host ?? "127.0.0.1",
    port,
    profile,
    legacyStateless,
  };
}

async function requestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function webHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  target.end();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const handler = createBioMcpHandler({
    cwd: options.cwd,
    catalogRoot: options.catalogRoot,
    dbPath: options.dbPath,
    cas: fsCasStore(options.casRoot),
    profile: options.profile,
    legacy: options.legacyStateless ? "stateless" : "reject",
    onerror: (error) => console.error(`pi-bio-mcp: ${error.message}`),
  });

  const http = createServer(async (request, response) => {
    try {
      const base = `http://${options.host}:${options.port}`;
      const url = new URL(request.url ?? "/", base);
      if (url.pathname !== "/mcp") {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      const body = await requestBody(request);
      const webRequest = new Request(url, {
        method: request.method,
        headers: webHeaders(request),
        body: body === undefined ? undefined : new Uint8Array(body),
      });
      await sendResponse(await handler.fetch(webRequest), response);
    } catch (error) {
      response.statusCode = error instanceof Error && /exceeds/.test(error.message) ? 413 : 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  const shutdown = async () => {
    http.close();
    await handler.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  http.listen(options.port, options.host, () => {
    console.log(`pi-bio-mcp listening at http://${options.host}:${options.port}/mcp`);
    console.log(`profile=${options.profile} protocol=${"2026-07-28"} legacy=${options.legacyStateless ? "stateless" : "reject"}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
