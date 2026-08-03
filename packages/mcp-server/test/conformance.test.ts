import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fsCasStore } from "pi-bio-agent";
import { BIO_MCP_PROTOCOL_VERSION, createBioMcpHandler } from "../src/index.js";

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": BIO_MCP_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "pi-bio-conformance", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernRequest(method: string, params: Record<string, unknown>, name?: string): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  });
}

async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-bio-mcp-conformance-"));
  const root = join(cwd, "manifests");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "fixture.json"), JSON.stringify({
    schema: "pi-bio.manifest.v1",
    id: "conformance.fixture",
    version: "0.1.0",
    title: "Conformance fixture",
    description: "Resource-free fixture for MCP security and failure behavior.",
    provides: {
      operations: [{
        id: "fixture.one",
        version: "0.1.0",
        title: "One",
        description: "Return one.",
        transport: "duckdb.sql",
        inputSchema: { type: "object" },
        sql: { readOnly: true, sqlTemplate: "SELECT 1 AS one" },
      }],
    },
  }, null, 2));
  return { cwd, root };
}

async function toolCall(handler: ReturnType<typeof createBioMcpHandler>, name: string, args: Record<string, unknown>) {
  const response = await handler.fetch(modernRequest("tools/call", { name, arguments: args }, name));
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> } };
  return body.result;
}

describe("MCP adapter conformance", () => {
  test("delegates dynamic-SQL and protected-variable rejection to the public core", async () => {
    const { cwd } = await setup();
    const secret = "must-never-leak";
    const handler = createBioMcpHandler({
      cwd,
      catalogRoot: "manifests",
      cas: fsCasStore(join(cwd, "cas")),
      protectedSessionBindings: { api_token: secret },
    });

    const dynamic = await toolCall(handler, "bio_query", {
      manifestId: "conformance.fixture",
      sql: "SELECT * FROM query('SELECT 1')",
      runId: "mcp-dynamic-rejected",
    });
    assert.equal(dynamic.isError, true);
    assert.match(dynamic.content?.[0]?.text ?? "", /dynamic-SQL|query\(\)|query_table/);

    const protectedRead = await toolCall(handler, "bio_query", {
      manifestId: "conformance.fixture",
      sql: "SELECT getvariable('api_token') AS token",
      runId: "mcp-secret-rejected",
    });
    assert.equal(protectedRead.isError, true);
    const serialized = JSON.stringify(protectedRead);
    assert.match(serialized, /protected session variable/i);
    assert.doesNotMatch(serialized, new RegExp(secret));

    await handler.close();
  });

  test("records an undeclared-relation failure rather than inventing data", async () => {
    const { cwd } = await setup();
    const handler = createBioMcpHandler({
      cwd,
      catalogRoot: "manifests",
      cas: fsCasStore(join(cwd, "cas")),
    });
    const result = await toolCall(handler, "bio_query", {
      manifestId: "conformance.fixture",
      sql: "SELECT * FROM relation_not_declared_or_present",
      runId: "mcp-missing-relation",
    });
    assert.equal(result.isError, undefined);
    const envelope = result.structuredContent as { data: { ok: boolean; error?: string; evidence: Record<string, string> } };
    assert.equal(envelope.data.ok, false);
    assert.match(envelope.data.error ?? "", /does not exist|not found/i);
    assert.match(envelope.data.evidence.run, /^pi-bio:\/\/runs\//);
    await handler.close();
  });

  test("does not turn manifest identifiers into filesystem paths", async () => {
    const { cwd } = await setup();
    const handler = createBioMcpHandler({ cwd, catalogRoot: "manifests", cas: fsCasStore(join(cwd, "cas")) });
    const result = await toolCall(handler, "bio_describe_model", { manifestId: "../../outside" });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /not present in the host-approved catalog/);
    await handler.close();
  });

  test("operations-only omits ad-hoc SQL and strict modern mode rejects initialize", async () => {
    const { cwd } = await setup();
    const handler = createBioMcpHandler({
      cwd,
      catalogRoot: "manifests",
      cas: fsCasStore(join(cwd, "cas")),
      profile: "operations-only",
    });

    const listed = await handler.fetch(modernRequest("tools/list", {}));
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
    const names = listedBody.result.tools.map((tool) => tool.name);
    assert.equal(names.includes("bio_query"), false);
    assert.ok(names.includes("bio_run_operation"));

    const legacyInitialize = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
      }),
    }));
    assert.notEqual(legacyInitialize.status, 200);
    assert.equal(legacyInitialize.headers.has("mcp-session-id"), false);
    const rejection = await legacyInitialize.text();
    assert.match(rejection, /unsupported|protocol/i);
    await handler.close();
  });
});
