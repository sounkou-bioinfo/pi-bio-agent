import { describe, expect, it, vi } from "vitest";
import type { AgentService } from "../src/agent-service.js";
import { createApp } from "../src/app.js";

function fixture(token?: string) {
  const agents = {
    modelIdentity: "faux/model",
    saveDraft: vi.fn(async () => undefined),
    selectModel: vi.fn(async () => undefined),
    selectThinking: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    archiveSession: vi.fn(async () => undefined),
    restoreSession: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ id: "fork", name: "Fork", createdAt: 0, modifiedAt: 0 })),
    sessionTree: vi.fn(async () => ({ entries: [], lanes: [] })),
    credentials: {
      catalog: vi.fn(() => []),
      status: vi.fn(async (providerId: string) => ({ providerId, status: "connected" as const })),
      login: vi.fn(async (providerId: string) => ({ providerId, status: "connecting" as const })),
      answer: vi.fn(async (providerId: string) => ({ providerId, status: "connecting" as const })),
      cancel: vi.fn(async (providerId: string) => ({ providerId, status: "disconnected" as const })),
      logout: vi.fn(async (providerId: string) => ({ providerId, status: "disconnected" as const })),
    },
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({
      id: "session-1",
      name: "Analysis",
      createdAt: 1,
      modifiedAt: 1,
    })),
    snapshot: vi.fn<AgentService["snapshot"]>(async () => ({
      lane: "main", tipId: null, configuration: { model: { provider: "faux", modelId: "model" }, thinkingLevel: "off", activeToolNames: [] }, draft: "", eventCursor: 1,
      transcript: [], operation: null, faulted: false, queues: [],
      stats: { messageCount: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    })),
    startPrompt: vi.fn(async () => "operation-1"),
    abort: vi.fn(async () => undefined),
    subscribe: vi.fn<AgentService["subscribe"]>(async () => () => undefined),
  };
  const science = {
    status: () => ({ worker: "stopped" as const, duckdb: "idle" as const, r: "idle" as const }),
  };
  return {
    agents,
    app: createApp({ agents, science, ...(token === undefined ? {} : { apiToken: token }) }),
  };
}

describe("Pi Bio API", () => {
  it("keeps health available without authentication", async () => {
    const { app } = fixture("secret");
    const response = await app.request("/health");
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
  });

  it("sends a snapshot first even when a reconnect supplies an old cursor", async () => {
    const { app, agents } = fixture();
    const unsubscribe = vi.fn();
    const snapshot = await agents.snapshot("one");
    agents.subscribe.mockImplementation(async (id, listener) => {
      listener({ sessionId: id, sequence: 1, event: { type: "snapshot", snapshot } });
      return unsubscribe;
    });
    const response = await app.request("/api/sessions/one/events?after=9999999");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('"type":"snapshot"');
    expect(agents.subscribe).toHaveBeenCalledWith("one", expect.any(Function));
    await reader.cancel();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("cleans up when the client disconnects while subscription is opening", async () => {
    const { app, agents } = fixture();
    const unsubscribe = vi.fn();
    let release: (() => void) | undefined;
    agents.subscribe.mockImplementation(() => new Promise((resolve) => { release = () => resolve(unsubscribe); }));
    const response = await app.request("/api/sessions/one/events");
    await response.body!.cancel();
    release?.();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("disconnects a lagging stream instead of accumulating unlimited frames", async () => {
    const { app, agents } = fixture();
    const unsubscribe = vi.fn();
    agents.subscribe.mockImplementation(async (id, listener) => {
      for (let sequence = 1; sequence <= 130; sequence++) {
        listener({ sessionId: id, sequence, event: { type: "application_error", operationId: "test", message: "frame" } });
      }
      return unsubscribe;
    });
    const response = await app.request("/api/sessions/one/events");
    expect((await response.body!.getReader().read()).done).toBe(true);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("requires the configured bearer token", async () => {
    const { app } = fixture("secret");
    expect((await app.request("/api/runtime")).status).toBe(401);
    expect(
      (
        await app.request("/api/runtime", {
          headers: { authorization: "Bearer secret" },
        })
      ).status,
    ).toBe(200);
  });

  it("forwards provider-owned login without hardcoding an OAuth flow", async () => {
    const { app, agents } = fixture();
    const response = await app.request("/api/providers/test-provider/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "oauth" }),
    });
    expect(response.status).toBe(202);
    expect(agents.credentials.login).toHaveBeenCalledWith("test-provider", { type: "oauth" });
  });

  it("saves draft text through the workspace store", async () => {
    const { app, agents } = fixture();
    const response = await app.request("/api/sessions/one/draft", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Unfinished analysis" }),
    });
    expect(response.status).toBe(200);
    expect(agents.saveDraft).toHaveBeenCalledWith("one", "Unfinished analysis");
  });

  it("returns JSON for unknown API routes and rejects foreign browser origins", async () => {
    const { app } = fixture();
    const missing = await app.request("/api/not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    const foreign = await app.request("/api/sessions", { method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" }, body: "{}" });
    expect(foreign.status).toBe(403);
  });

  it("validates and admits prompts", async () => {
    const { app, agents } = fixture();
    const response = await app.request("/api/sessions/session-1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "select 42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ operationId: "operation-1" });
    expect(agents.startPrompt).toHaveBeenCalledWith("session-1", "select 42");
  });

  it("rejects undeclared prompt capabilities", async () => {
    const { app } = fixture();
    const response = await app.request("/api/sessions/session-1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "select 42", shell: true }),
    });
    expect(response.status).toBe(400);
  });
});
