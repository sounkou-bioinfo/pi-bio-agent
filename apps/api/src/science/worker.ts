import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ScienceRequest,
  ScienceResponse,
  ScienceState,
} from "./protocol.js";

type LegacyTool = {
  execute(toolCallId: string, params: unknown): Promise<{ details?: unknown; content?: unknown }>;
};

type ShutdownHandler = () => void | Promise<void>;

const databasePath = process.env.PI_BIO_SCIENCE_DB;
if (databasePath === undefined || databasePath.length === 0) {
  throw new Error("PI_BIO_SCIENCE_DB is required");
}

await mkdir(dirname(databasePath), { recursive: true });
const instance = await DuckDBInstance.create(databasePath);
const connection = await instance.connect();
const state: ScienceState = { duckdb: "ready", r: "idle" };
let rTools: Map<string, LegacyTool> | undefined;
let shutdownHandlers: ShutdownHandler[] = [];
const rScopes = new Set<string>();
let tail = Promise.resolve();
let closing = false;

await connection.run(`
  CREATE SCHEMA IF NOT EXISTS pi;
  CREATE TABLE IF NOT EXISTS pi.workspace_metadata (
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL
  );
  INSERT OR REPLACE INTO pi.workspace_metadata VALUES
    ('schema_version', '1'),
    ('application', 'pi-bio-agent');
`);

process.on("message", (message: ScienceRequest) => {
  if (!isScienceRequest(message)) return;
  tail = tail.then(() => handleRequest(message)).catch((error: unknown) => {
    sendResponse({
      type: "response",
      id: message.id,
      ok: false,
      error: errorText(error),
      state: { ...state },
    });
  });
});

process.on("disconnect", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("SIGINT", () => {
  void shutdown(130);
});

process.send?.({ type: "ready", state: { ...state } });

async function handleRequest(request: ScienceRequest): Promise<void> {
  switch (request.operation) {
    case "status":
      return respond(request.id, { ...state });
    case "sql":
      return respond(request.id, await executeSql(required(request.sql, "sql"), request.maxRows));
    case "r_eval":
      return respond(
        request.id,
        await executeR(
          requiredScope(request.scope),
          required(request.code, "code"),
          request.maxRows,
        ),
      );
    case "r_reset":
      await resetRScope(requiredScope(request.scope));
      return respond(request.id, { reset: true });
    case "close":
      respond(request.id, { closed: true });
      await shutdown(0);
      return;
  }
}

async function executeSql(sql: string, requestedMaxRows = 100): Promise<unknown> {
  if (sql.length > 200_000) throw new Error("SQL exceeds the 200000 character limit");
  const maxRows = boundedRows(requestedMaxRows);
  const reader = await connection.runAndReadUntil(sql, maxRows + 1);
  const rows = reader.getRowObjectsJson();
  const preview = rows.slice(0, maxRows);
  return {
    columns: reader.columnNamesAndTypesJson(),
    previewRowCount: preview.length,
    rows: preview,
    truncated: rows.length > maxRows,
  };
}

async function executeR(
  scope: string,
  code: string,
  requestedMaxRows = 100,
): Promise<unknown> {
  if (code.length > 200_000) throw new Error("R code exceeds the 200000 character limit");
  const { call, url } = await rEndpoint();
  if (!rScopes.has(scope)) {
    const quoted = JSON.stringify(scope);
    await call.execute(`science-worker-init-r-${scope}`, {
      url,
      method: "eval",
      arguments: {
        code: `if (!exists(".pi_bio_scopes", inherits = FALSE)) .pi_bio_scopes <- new.env(parent = emptyenv()); if (!exists(${quoted}, envir = .pi_bio_scopes, inherits = FALSE)) assign(${quoted}, new.env(parent = .GlobalEnv), envir = .pi_bio_scopes); data.frame(initialized = TRUE)`,
      },
    });
    rScopes.add(scope);
  }
  const response = await call.execute(`science-worker-eval-r-${scope}`, {
    url,
    method: "eval",
    arguments: {
      code,
      envir: `get(${JSON.stringify(scope)}, envir = .pi_bio_scopes, inherits = FALSE)`,
      enclos: "baseenv()",
    },
  });
  const result = objectValue(response.details, "result");
  return boundedValue(result, boundedRows(requestedMaxRows));
}

async function rEndpoint(): Promise<{ call: LegacyTool; url: string }> {
  const tools = await ensureRTools();
  const start = requireTool(tools, "persistent_r_start");
  const describe = requireTool(tools, "ducknng_describe");
  const call = requireTool(tools, "ducknng_call");
  const endpoint = await start.execute("science-worker-r-endpoint", {});
  const url = objectString(endpoint.details, "url");
  if (state.r !== "ready") {
    await describe.execute("science-worker-describe-r", { url });
    state.r = "ready";
  }
  return { call, url };
}

async function ensureRTools(): Promise<Map<string, LegacyTool>> {
  if (rTools !== undefined) return rTools;
  try {
    const moduleUrl = new URL(
      "../vendor/pi-ducknng/extensions/pi-ducknng/index.js",
      import.meta.url,
    );
    const extensionModule = (await import(moduleUrl.href)) as {
      default(api: unknown): void | Promise<void>;
    };
    const tools = new Map<string, LegacyTool>();
    const handlers: ShutdownHandler[] = [];
    await extensionModule.default({
      registerTool(tool: LegacyTool & { name: string }): void {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: ShutdownHandler): () => void {
        if (event === "session_shutdown") handlers.push(handler);
        return () => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    });
    rTools = tools;
    shutdownHandlers = handlers;
    return tools;
  } catch (error) {
    state.r = "unavailable";
    throw new Error(`R/NNG runtime unavailable: ${errorText(error)}`);
  }
}

async function resetRScope(scope: string): Promise<void> {
  if (state.r !== "ready" || !rScopes.has(scope)) return;
  const { call, url } = await rEndpoint();
  await call.execute(`science-worker-reset-r-${scope}`, {
    url,
    method: "eval",
    arguments: {
      code: `if (exists(${JSON.stringify(scope)}, envir = .pi_bio_scopes, inherits = FALSE)) rm(list = ${JSON.stringify(scope)}, envir = .pi_bio_scopes); data.frame(reset = TRUE)`,
    },
  });
  rScopes.delete(scope);
}

async function resetR(): Promise<void> {
  for (const handler of shutdownHandlers.splice(0).reverse()) await handler();
  rTools = undefined;
  rScopes.clear();
  state.r = "idle";
}

async function shutdown(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await resetR();
  } catch {
    // Process shutdown remains authoritative.
  }
  connection.closeSync();
  instance.closeSync();
  process.disconnect?.();
  process.exit(code);
}

function respond(id: string, value: unknown): void {
  sendResponse({ type: "response", id, ok: true, value, state: { ...state } });
}

function sendResponse(response: ScienceResponse): void {
  process.send?.(response);
}

function requireTool(tools: Map<string, LegacyTool>, name: string): LegacyTool {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`pi-ducknng did not register ${name}`);
  return tool;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredScope(value: string | undefined): string {
  const scope = required(value, "scope");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope)) throw new Error("scope is invalid");
  return scope;
}

function boundedRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(1_000, Math.trunc(value)));
}

function boundedValue(value: unknown, maxRows: number): unknown {
  if (!Array.isArray(value)) return value;
  return {
    rowCount: value.length,
    rows: value.slice(0, maxRows),
    truncated: value.length > maxRows,
  };
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`Malformed pi-ducknng response: missing ${key}`);
  }
  return (value as Record<string, unknown>)[key];
}

function objectString(value: unknown, key: string): string {
  const field = objectValue(value, key);
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Malformed pi-ducknng response: ${key} is not a string`);
  }
  return field;
}

function isScienceRequest(value: unknown): value is ScienceRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { operation?: unknown }).operation === "string"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
