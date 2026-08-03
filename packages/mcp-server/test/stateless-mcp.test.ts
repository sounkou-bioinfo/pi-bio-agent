import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fsCasStore } from "pi-bio-agent";
import {
  BIO_MCP_PROTOCOL_VERSION,
  createBioMcpHandler,
  createBioMcpServer,
  type BioMcpHostOptions,
} from "../src/index.js";

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": BIO_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "pi-bio-mcp-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface JsonRpcBody {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

function request(method: string, params: Record<string, unknown>, name?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
  };
  if (name) headers["mcp-name"] = name;
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}:${name ?? "request"}`,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
}

async function rpc(handler: ReturnType<typeof createBioMcpHandler>, method: string, params: Record<string, unknown>, name?: string) {
  const response = await handler.fetch(request(method, params, name));
  const body = await response.json() as JsonRpcBody;
  return { response, body };
}

async function callTool(handler: ReturnType<typeof createBioMcpHandler>, name: string, args: Record<string, unknown>) {
  const { response, body } = await rpc(handler, "tools/call", { name, arguments: args }, name);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.has("mcp-session-id"), false, "the final protocol must not create a transport session");
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  const result = body.result as { isError?: boolean; content?: unknown; structuredContent?: unknown };
  return { response, result };
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

async function fixture(): Promise<{ options: BioMcpHostOptions; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bio-mcp-"));
  const manifests = join(cwd, "manifests");
  await mkdir(manifests, { recursive: true });
  await writeFile(join(manifests, "fixture.json"), JSON.stringify({
    schema: "pi-bio.manifest.v1",
    id: "mcp.fixture",
    version: "0.1.0",
    title: "Stateless MCP fixture",
    description: "Domain-independent fixture for the provider-neutral MCP adapter.",
    provides: {
      operations: [{
        id: "fixture.answer",
        version: "0.1.0",
        title: "Return an answer",
        description: "A resource-free named operation.",
        transport: "duckdb.sql",
        inputSchema: { type: "object" },
        sql: { readOnly: true, sqlTemplate: "SELECT 7 AS answer" },
      }],
    },
  }, null, 2), "utf8");
  return {
    cwd,
    options: {
      cwd,
      catalogRoot: "manifests",
      cas: fsCasStore(join(cwd, "cas")),
      profile: "exploratory",
    },
  };
}

describe("stateless MCP 2026-07-28 adapter", () => {
  test("discovers, queries, reads evidence and reproduces across independent requests", async () => {
    const { options } = await fixture();
    const handler = createBioMcpHandler(options);

    const discovered = await rpc(handler, "server/discover", {});
    assert.equal(discovered.response.status, 200, JSON.stringify(discovered.body));
    assert.equal(discovered.response.headers.has("mcp-session-id"), false);
    const supported = record(discovered.body.result, "server/discover result").supportedVersions;
    assert.deepEqual(supported, [BIO_MCP_PROTOCOL_VERSION]);

    const listed = await rpc(handler, "tools/list", {});
    assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.response.headers.has("mcp-session-id"), false);
    const toolNames = (record(listed.body.result, "tools/list result").tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes("bio_query"));
    assert.ok(toolNames.includes("bio_reproduce_run"));

    const sources = await callTool(handler, "bio_list_sources", {});
    const sourceEnvelope = record(sources.result.structuredContent, "source envelope");
    const sourceData = record(sourceEnvelope.data, "source data");
    const entries = sourceData.entries as Array<{ id: string; resourceUri: string }>;
    assert.deepEqual(entries.map((entry) => entry.id), ["mcp.fixture"]);
    assert.equal(entries[0]!.resourceUri, "pi-bio://manifests/mcp.fixture");

    const query = await callTool(handler, "bio_query", {
      manifestId: "mcp.fixture",
      sql: "SELECT 42 AS answer",
      runId: "mcp-stateless-query",
      resultDelivery: "inline",
    });
    assert.equal(query.result.isError, undefined);
    const queryData = record(record(query.result.structuredContent, "query envelope").data, "query data");
    assert.equal(queryData.ok, true);
    const queryResult = record(queryData.result, "query result");
    assert.deepEqual(queryResult.rows, [{ answer: 42 }]);

    const replayUri = record(queryData.evidence, "query evidence").replay as string;
    const readReplay = await rpc(handler, "resources/read", { uri: replayUri }, replayUri);
    assert.equal(readReplay.response.status, 200, JSON.stringify(readReplay.body));
    assert.equal(readReplay.response.headers.has("mcp-session-id"), false);
    const replayContents = record(readReplay.body.result, "resource result").contents as Array<{ text: string }>;
    const replay = JSON.parse(replayContents[0]!.text) as { runId: string; resultDigest?: string };
    assert.equal(replay.runId, "mcp-stateless-query");
    assert.match(replay.resultDigest ?? "", /^sha256:[0-9a-f]{64}$/);

    const reproduced = await callTool(handler, "bio_reproduce_run", { runId: "mcp-stateless-query" });
    const reproduction = record(record(reproduced.result.structuredContent, "reproduction envelope").data, "reproduction data");
    assert.equal(reproduction.reproduced, true);
    assert.equal(reproduction.matched, true);
    assert.equal(reproduction.resultMatched, true);

    await handler.close();
  });

  test("uses the same public named-operation runner without an initialize handshake", async () => {
    const { options } = await fixture();
    const handler = createBioMcpHandler(options);
    const operation = await callTool(handler, "bio_run_operation", {
      manifestId: "mcp.fixture",
      operationId: "fixture.answer",
      runId: "mcp-named-operation",
      resultDelivery: "inline",
    });
    const data = record(record(operation.result.structuredContent, "operation envelope").data, "operation data");
    assert.equal(data.ok, true);
    assert.deepEqual(record(data.result, "operation result").rows, [{ answer: 7 }]);
    await handler.close();
  });

  test("sealed-offline construction requires pinned output storage and refuses explicit effect ports", async () => {
    const { cwd } = await fixture();
    await assert.rejects(
      () => createBioMcpServer({ cwd, catalogRoot: "manifests", profile: "sealed-offline" }),
      /requires a CAS/,
    );
    await assert.rejects(
      () => createBioMcpServer({
        cwd,
        catalogRoot: "manifests",
        profile: "sealed-offline",
        cas: fsCasStore(join(cwd, "sealed-cas")),
        network: { fetch: globalThis.fetch },
      }),
      /refuses network/,
    );
  });
});
