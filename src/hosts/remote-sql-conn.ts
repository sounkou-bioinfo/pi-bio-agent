import { createServer, validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { SqlConn, SqlConnPolicy } from "../core/ports.js";
import { wrapSqlConn } from "../core/ports.js";

export const SQL_CONN_WIRE_SCHEMA = "pi-bio.sql_conn_wire.v1";
export const SQL_CONN_HTTP_PATH = "/sql-conn";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_ID_BYTES = 128;

export type SqlConnMethod = "all" | "run";

export type SqlConnValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | Uint8Array
  | SqlConnValue[]
  | { [key: string]: SqlConnValue };

type WireTuple =
  | ["null"]
  | ["boolean", boolean]
  | ["number", number]
  | ["string", string]
  | ["bigint", string]
  | ["bytes", string]
  | ["array", readonly WireTuple[]]
  | ["object", readonly [string, WireTuple][]];

interface WireRequest {
  schema: string;
  requestId: string;
  method: SqlConnMethod;
  sql: string;
  params: SqlConnValue[];
}

interface ParsedWireAllResponse {
  schema: string;
  requestId: string;
  method: "all";
  rows: readonly SqlConnValue[];
}

interface WireErrorResponse {
  schema: string;
  requestId: string;
  error: {
    code: string;
    message: string;
  };
}

type WireResponse = ParsedWireAllResponse | { schema: string; requestId: string; method: "run"; ok: true } | WireErrorResponse;
type OutgoingResponse = { schema: string; requestId: string; method: "all"; rows: readonly WireTuple[] } | { schema: string; requestId: string; method: "run"; ok: true } | WireErrorResponse;

export interface SqlConnWireTransport {
  request(raw: string, requestId: string): Promise<string>;
}

interface SqlConnHttpErrorMapperContext {
  code: string;
  requestId: string;
  cause?: unknown;
}

export type SqlConnHttpErrorMapper = (context: SqlConnHttpErrorMapperContext) => string | undefined;

export interface SqlConnHttpServerOptions {
  conn: SqlConn;
  host?: string;
  port?: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  policy?: SqlConnPolicy;
  bearerToken?: string;
  authorize?: (ctx: { requestId: string; method: SqlConnMethod; sql: string; params: readonly SqlConnValue[] }) => Promise<void> | void;
  mapError?: SqlConnHttpErrorMapper;
}

export interface SqlConnHttpClientOptions {
  endpoint: string;
  bearerToken?: string;
  requestId?: () => string;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  fetchImpl?: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface SqlConnHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_ERROR_MESSAGES: Record<string, string> = {
  unknown_path: "unknown path",
  method_not_allowed: "only POST is accepted",
  invalid_content_type: "unsupported content type",
  unauthorized: "request is unauthorized",
  payload_too_large: "request payload too large",
  invalid_request: "malformed request",
  sql_error: "sql execution failed",
  response_too_large: "response payload too large",
  response_parse_error: "remote response was invalid",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length) {
    throw protocolError("invalid_request", "invalid envelope keys");
  }

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw protocolError("invalid_request", `missing key ${key}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isApplicationJson(contentType: unknown): boolean {
  if (typeof contentType === "string") {
    return contentType.toLowerCase().split(";")[0].trim() === "application/json";
  }
  if (Array.isArray(contentType)) {
    return contentType.some((entry) => isApplicationJson(entry));
  }
  return false;
}

function isSafeRequestId(value: string): boolean {
  if (value.length === 0 || value.trim() !== value || Buffer.byteLength(value, "utf8") > MAX_REQUEST_ID_BYTES) return false;
  try {
    validateHeaderValue("x-request-id", value);
    return true;
  } catch {
    return false;
  }
}

function parseRequestId(raw: unknown): string {
  if (typeof raw !== "string" || !isSafeRequestId(raw)) {
    throw protocolError("invalid_request", "requestId is not safe");
  }
  return raw;
}

function parseRequestIdHeader(raw: string | string[] | undefined): string | undefined {
  if (raw == null) return undefined;
  const header = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (header == null) throw protocolError("invalid_request", "invalid x-request-id header");
  const parsed = header.trim();
  if (!isSafeRequestId(parsed)) throw protocolError("invalid_request", "invalid x-request-id header");
  return parsed;
}

function protocolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeBearerToken(raw: string | undefined): string {
  if (raw == null) return "";
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return "";
  return trimmed.slice(7).trim();
}

function isAuthorizedBearerToken(header: string | string[] | undefined, expectedToken: string): boolean {
  const expected = expectedToken.trim();
  const candidates = Array.isArray(header) ? header : [header];
  let ok = false;
  for (const raw of candidates) {
    const presented = normalizeBearerToken(raw);
    ok = ok || (presented.length > 0 && timingSafeEqualPadded(expected, presented));
  }
  return ok;
}

function timingSafeEqualPadded(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  const size = Math.max(left.length, right.length);
  const lhs = Buffer.alloc(size + 4);
  const rhs = Buffer.alloc(size + 4);
  left.copy(lhs, 0);
  right.copy(rhs, 0);
  lhs.writeUInt32BE(left.length, size);
  rhs.writeUInt32BE(right.length, size);
  return timingSafeEqual(lhs, rhs);
}

function isBase64(raw: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(raw) && raw.length % 4 === 0;
}

function encodeSqlConnValue(value: unknown, path: string, seen: Set<object>): WireTuple {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return ["number", value];
  }

  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["bigint", value.toString()];

  if (value instanceof Uint8Array) {
    return ["bytes", Buffer.from(value).toString("base64")];
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`circular value at ${path}`);
    seen.add(value);
    try {
      return ["array", value.map((entry, i) => encodeSqlConnValue(entry, `${path}[${i}]`, seen))];
    } finally {
      seen.delete(value);
    }
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) throw new Error(`circular value at ${path}`);
    seen.add(value);
    try {
      const entries = Object.entries(value).map(([key, nested]) => {
        if (nested === undefined) {
          throw new Error(`undefined value at ${path}.${key}`);
        }
        return [key, encodeSqlConnValue(nested, `${path}.${key}`, seen)] as [string, WireTuple];
      });
      return ["object", entries];
    } finally {
      seen.delete(value);
    }
  }

  if (value === undefined) throw new Error(`undefined value at ${path}`);
  throw new Error(`unsupported value at ${path} (${typeof value})`);
}

function decodeSqlConnValue(value: unknown, path: string): SqlConnValue {
  if (!Array.isArray(value)) {
    throw protocolError("response_parse_error", `invalid tuple at ${path}`);
  }
  if (value.length < 1 || value.length > 3) {
    throw protocolError("response_parse_error", `invalid tuple at ${path}`);
  }

  const kind = value[0];
  const payload = value.slice(1);

  switch (kind) {
    case "null": {
      if (payload.length !== 0) throw protocolError("response_parse_error", `invalid null tuple at ${path}`);
      return null;
    }
    case "boolean": {
      if (payload.length !== 1 || typeof payload[0] !== "boolean") {
        throw protocolError("response_parse_error", `invalid boolean tuple at ${path}`);
      }
      return payload[0];
    }
    case "number": {
      if (payload.length !== 1 || typeof payload[0] !== "number" || !Number.isFinite(payload[0])) {
        throw protocolError("response_parse_error", `invalid number tuple at ${path}`);
      }
      return payload[0];
    }
    case "string": {
      if (payload.length !== 1 || typeof payload[0] !== "string") {
        throw protocolError("response_parse_error", `invalid string tuple at ${path}`);
      }
      return payload[0];
    }
    case "bigint": {
      if (payload.length !== 1 || typeof payload[0] !== "string" || !/^-?(0|[1-9]\d*)$/.test(payload[0])) {
        throw protocolError("response_parse_error", `invalid bigint tuple at ${path}`);
      }
      return BigInt(payload[0]);
    }
    case "bytes": {
      if (payload.length !== 1 || typeof payload[0] !== "string" || !isBase64(payload[0])) {
        throw protocolError("response_parse_error", `invalid bytes tuple at ${path}`);
      }
      return Buffer.from(payload[0], "base64");
    }
    case "array": {
      if (payload.length !== 1 || !Array.isArray(payload[0])) {
        throw protocolError("response_parse_error", `invalid array tuple at ${path}`);
      }
      return payload[0].map((entry, i) => decodeSqlConnValue(entry, `${path}[${i}]`));
    }
    case "object": {
      if (payload.length !== 1 || !Array.isArray(payload[0])) {
        throw protocolError("response_parse_error", `invalid object tuple at ${path}`);
      }
      const entries = payload[0];
      const obj = Object.create(null) as Record<string, SqlConnValue>;
      const keys = new Set<string>();
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
          throw protocolError("response_parse_error", `invalid object entry at ${path}`);
        }
        if (keys.has(pair[0])) throw protocolError("response_parse_error", `duplicate object key at ${path}`);
        keys.add(pair[0]);
        obj[pair[0]] = decodeSqlConnValue(pair[1], `${path}[${pair[0]}]`);
      }
      return obj;
    }
    default:
      throw protocolError("response_parse_error", `invalid tuple kind '${String(kind)}' at ${path}`);
  }
}

function parseRequest(raw: string): WireRequest {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw protocolError("invalid_request", "request must be object");
  if (parsed.schema !== SQL_CONN_WIRE_SCHEMA) throw protocolError("invalid_request", "unexpected wire schema");
  hasExactKeys(parsed, ["schema", "requestId", "method", "sql", "params"]);

  const requestId = parseRequestId(parsed.requestId);
  const method = parsed.method;
  if (method !== "all" && method !== "run") throw protocolError("invalid_request", "invalid method");
  if (typeof parsed.sql !== "string") throw protocolError("invalid_request", "sql must be string");
  if (!Array.isArray(parsed.params)) throw protocolError("invalid_request", "params must be array");

  const params = parsed.params.map((entry, i) => decodeSqlConnValue(entry, `params[${i}]`));
  return {
    schema: parsed.schema,
    requestId,
    method,
    sql: parsed.sql,
    params,
  };
}

function parseResponse(raw: string): WireResponse {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw protocolError("response_parse_error", "response must be object");
  if (parsed.schema !== SQL_CONN_WIRE_SCHEMA) throw protocolError("response_parse_error", "unexpected wire schema");

  const requestId = parseRequestId(parsed.requestId);

  if (isRecord(parsed.error)) {
    hasExactKeys(parsed, ["schema", "requestId", "error"]);
    if (Object.keys(parsed.error).length !== 2) {
      throw protocolError("response_parse_error", "invalid error payload");
    }
    const code = parsed.error.code;
    const message = parsed.error.message;
    if (typeof code !== "string" || !code.trim() || typeof message !== "string" || !message.trim()) {
      throw protocolError("response_parse_error", "invalid error fields");
    }
    return { schema: parsed.schema, requestId, error: { code, message } };
  }

  if (parsed.method !== "all" && parsed.method !== "run") throw protocolError("response_parse_error", "invalid method");

  if (parsed.method === "run") {
    hasExactKeys(parsed, ["schema", "requestId", "method", "ok"]);
    if (parsed.ok !== true) throw protocolError("response_parse_error", "run response must include ok");
    return { schema: parsed.schema, requestId, method: "run", ok: true };
  }

  hasExactKeys(parsed, ["schema", "requestId", "method", "rows"]);
  if (!Array.isArray(parsed.rows)) throw protocolError("response_parse_error", "rows must be array");
  return {
    schema: parsed.schema,
    requestId,
    method: "all",
    rows: parsed.rows.map((entry, i) => decodeSqlConnValue(entry, `rows[${i}]`)),
  };
}

function wireErrorPayload(code: string, requestId: string, mapError?: SqlConnHttpErrorMapper, cause?: unknown): WireErrorResponse {
  const fallback = DEFAULT_ERROR_MESSAGES[code] ?? "remote sql connection failed";
  let mapped: string | undefined;
  try { mapped = mapError?.({ code, requestId, cause }); } catch { mapped = undefined; }
  return {
    schema: SQL_CONN_WIRE_SCHEMA,
    requestId,
    error: {
      code,
      message: mapped && mapped.trim() ? mapped : fallback,
    },
  };
}

function sendWireJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  payload: OutgoingResponse,
  maxBytes: number,
  mapError?: SqlConnHttpErrorMapper,
): void {
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    const fallback = JSON.stringify(wireErrorPayload("response_too_large", requestId, mapError));
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", requestId);
    res.end(fallback);
    return;
  }

  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-request-id", requestId);
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let consumed = 0;
    let finished = false;
    const chunks: Buffer[] = [];

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      if (finished) return;
      consumed += chunk.length;
      if (consumed > maxBytes) {
        fail(protocolError("payload_too_large", "request payload too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function encodeRequestParams(params: readonly unknown[], requestId: string): WireTuple[] {
  const seen = new Set<object>();
  return params.map((value, index) => encodeSqlConnValue(value, `request[${requestId}][${index}]`, seen));
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response body exceeded ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export function makeSqlConnClient(transport: SqlConnWireTransport, options: Omit<SqlConnHttpClientOptions, "endpoint" | "fetchImpl"> = {}): SqlConn {
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BYTES;
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? MAX_RESPONSE_BYTES;
  const nextRequestId = options.requestId ?? (() => randomUUID());

  const run = async <T>(method: SqlConnMethod, sql: string, params: readonly unknown[] = []): Promise<T> => {
    const requestId = parseRequestId(nextRequestId());
    const payload = {
      schema: SQL_CONN_WIRE_SCHEMA,
      requestId,
      method,
      sql,
      params: encodeRequestParams(params, requestId),
    };

    const rawRequest = JSON.stringify(payload);
    if (Buffer.byteLength(rawRequest, "utf8") > maxRequestBodyBytes) {
      throw new Error(`request payload exceeded ${maxRequestBodyBytes} bytes`);
    }

    const rawResponse = await transport.request(rawRequest, requestId);
    if (Buffer.byteLength(rawResponse, "utf8") > maxResponseBodyBytes) {
      throw new Error(`response body exceeded ${maxResponseBodyBytes} bytes`);
    }

    const response = parseResponse(rawResponse);
    if (response.requestId !== requestId) throw new Error("requestId mismatch");
    if ("error" in response) throw new Error(`${response.error.code}: ${response.error.message}`);
    if (response.method !== method) throw new Error(`response method '${response.method}' does not match request '${method}'`);

    return response.method === "run" ? (undefined as T) : (response.rows as T);
  };

  return {
    all: <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => run<T[]>("all", sql, params),
    run: (sql: string, params: readonly unknown[] = []): Promise<void> => run<void>("run", sql, params),
  };
}

export function createSqlConnHttpClient(options: SqlConnHttpClientOptions): SqlConn {
  const baseUrl = new URL(options.endpoint);
  const path = new URL(SQL_CONN_HTTP_PATH, baseUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs;
  const nextRequestId = options.requestId ?? (() => randomUUID());
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? MAX_RESPONSE_BYTES;

  const transport: SqlConnWireTransport = {
    async request(raw: string, requestId: string): Promise<string> {
      const controller = timeoutMs == null ? undefined : new AbortController();
      const timer = timeoutMs == null ? undefined : setTimeout(() => {
        controller?.abort(`timeout after ${timeoutMs}ms`);
      }, timeoutMs);

      try {
        const response = await fetchImpl(path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
          },
          body: raw,
          signal: controller?.signal,
        });

        const text = await readResponseText(response, maxResponseBodyBytes);
        if (!response.ok) {
          let parsed: WireResponse;
          try {
            parsed = parseResponse(text);
          } catch {
            throw new Error(`remote SQL server request failed with HTTP ${response.status}`);
          }
          if (parsed.requestId !== requestId) throw new Error("requestId mismatch");
          if ("error" in parsed) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
          throw new Error(`remote SQL server request failed with HTTP ${response.status}`);
        }

        return text;
      } finally {
        if (timer != null) clearTimeout(timer);
      }
    },
  };

  return makeSqlConnClient(transport, {
    requestId: nextRequestId,
    maxRequestBodyBytes: options.maxRequestBodyBytes ?? MAX_REQUEST_BYTES,
    maxResponseBodyBytes,
  });
}

export function createSqlConnHttpServer(options: SqlConnHttpServerOptions): Promise<SqlConnHttpServer> {
  if (!options.bearerToken && !options.authorize) {
    throw new Error("SqlConn HTTP server requires bearerToken or authorize callback");
  }
  if (options.bearerToken !== undefined && !options.bearerToken.trim()) {
    throw new Error("SqlConn HTTP server bearer token must be non-empty");
  }

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BYTES;
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? MAX_RESPONSE_BYTES;
  const conn = options.policy ? wrapSqlConn(options.conn, options.policy) : options.conn;
  const mapError = options.mapError;

  let lock: Promise<void> = Promise.resolve();
  const runSerialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lock.then(operation);
    lock = next.then(() => undefined).catch(() => undefined);
    return next;
  };

  const server = createServer(async (req, res) => {
    let requestId: string = randomUUID();
    let headerRequestId: string | undefined;

    try {
      headerRequestId = parseRequestIdHeader(req.headers["x-request-id"]);
      if (headerRequestId != null) requestId = headerRequestId;
    } catch (error) {
      sendWireJson(res, 400, requestId, wireErrorPayload("invalid_request", requestId, mapError, error), maxResponseBodyBytes, mapError);
      return;
    }

    if (req.url !== SQL_CONN_HTTP_PATH) {
      sendWireJson(res, 404, requestId, wireErrorPayload("unknown_path", requestId, mapError), maxResponseBodyBytes, mapError);
      return;
    }

    if (req.method !== "POST") {
      sendWireJson(res, 405, requestId, wireErrorPayload("method_not_allowed", requestId, mapError), maxResponseBodyBytes, mapError);
      return;
    }

    if (!isApplicationJson(req.headers["content-type"])) {
      sendWireJson(res, 415, requestId, wireErrorPayload("invalid_content_type", requestId, mapError), maxResponseBodyBytes, mapError);
      return;
    }

    if (options.bearerToken !== undefined && !isAuthorizedBearerToken(req.headers.authorization, options.bearerToken)) {
      sendWireJson(res, 401, requestId, wireErrorPayload("unauthorized", requestId, mapError), maxResponseBodyBytes, mapError);
      return;
    }

    let wireRequest: WireRequest;
    try {
      const raw = await readBody(req, maxRequestBodyBytes);
      wireRequest = parseRequest(raw);
      if (headerRequestId != null && headerRequestId !== wireRequest.requestId) {
        throw protocolError("invalid_request", "requestId header mismatch");
      }
      requestId = wireRequest.requestId;
    } catch (error) {
      const code = error instanceof Error && (error as Error & { code?: string }).code === "payload_too_large" ? "payload_too_large" : "invalid_request";
      const status = code === "payload_too_large" ? 413 : 400;
      sendWireJson(
        res,
        status,
        requestId,
        wireErrorPayload(code, requestId, mapError, error),
        maxResponseBodyBytes,
        mapError,
      );
      return;
    }

    try {
      if (options.authorize) {
        await options.authorize({ requestId: wireRequest.requestId, method: wireRequest.method, sql: wireRequest.sql, params: wireRequest.params });
      }
    } catch (error) {
      sendWireJson(
        res,
        403,
        requestId,
        wireErrorPayload("unauthorized", requestId, mapError, error),
        maxResponseBodyBytes,
        mapError,
      );
      return;
    }

    try {
      const result = await runSerialized(async () => {
        if (wireRequest.method === "all") {
          const rows = await conn.all(wireRequest.sql, wireRequest.params);
          if (!Array.isArray(rows)) throw new Error("SqlConn.all must return an array");
          const seen = new Set<object>();
          return { kind: "all" as const, rows: rows.map((row, i) => encodeSqlConnValue(row, `rows[${i}]`, seen)) };
        }
        await conn.run(wireRequest.sql, wireRequest.params);
        return { kind: "run" as const };
      });

      if (result.kind === "all") {
        sendWireJson(
          res,
          200,
          wireRequest.requestId,
          {
            schema: SQL_CONN_WIRE_SCHEMA,
            requestId: wireRequest.requestId,
            method: "all",
            rows: result.rows,
          },
          maxResponseBodyBytes,
          mapError,
        );
        return;
      }

      sendWireJson(
        res,
        200,
        wireRequest.requestId,
        {
          schema: SQL_CONN_WIRE_SCHEMA,
          requestId: wireRequest.requestId,
          method: "run",
          ok: true,
        },
        maxResponseBodyBytes,
        mapError,
      );
    } catch (error) {
      sendWireJson(
        res,
        500,
        wireRequest.requestId,
        wireErrorPayload("sql_error", wireRequest.requestId, mapError, error),
        maxResponseBodyBytes,
        mapError,
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("failed to initialize remote SQL server"));
        return;
      }
      resolve({
        url: `http://${host}:${address.port}`,
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done(undefined))),
      });
    });
  });
}
