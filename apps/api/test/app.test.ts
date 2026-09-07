import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

function fixture(token?: string) {
  const agents = {
    modelIdentity: "faux/model",
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({
      id: "session-1",
      name: "Analysis",
      createdAt: 1,
      modifiedAt: 1,
    })),
    snapshot: vi.fn(async () => ({ transcript: [], operation: null, faulted: false }) as never),
    startPrompt: vi.fn(async () => "operation-1"),
    abort: vi.fn(async () => undefined),
    subscribe: vi.fn(async () => () => undefined),
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
    expect(await (await app.request("/health")).json()).toEqual({ ok: true });
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
