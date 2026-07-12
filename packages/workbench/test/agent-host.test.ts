import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkbenchApi } from "../src/api/app.js";
import { createPiAgentHost } from "../src/pi-agent-host.js";

class FakePiSession {
  readonly sessionFile = "/host-owned/session.jsonl";
  readonly model = { provider: "test", id: "small-model" };
  readonly thinkingLevel = "low";
  readonly messages: unknown[] = [];
  readonly steering: string[] = [];
  readonly followUps: string[] = [];
  readonly commandList = [
    { name: "review", description: "Review the current work", source: "extension" as const },
    { name: "skill:pi-bio-agent", description: "Use the pi-bio-agent substrate", source: "skill" as const },
  ];
  readonly invokedCommands: string[] = [];
  private listeners = new Set<(event: unknown) => void>();
  private finishPrompt?: () => void;
  sessionName?: string;
  isStreaming = false;
  pendingMessageCount = 0;
  disposed = false;

  constructor(readonly sessionId: string) {}

  subscribe(listener: (event: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown) {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string, options?: { preflightResult?: (success: boolean) => void }) {
    if (text === "/review") {
      this.invokedCommands.push(text);
      options?.preflightResult?.(true);
      return;
    }
    this.isStreaming = true;
    this.messages.push({ role: "user", content: text, timestamp: 1 });
    this.emit({ type: "agent_start" });
    options?.preflightResult?.(true);
    await new Promise<void>((resolve) => { this.finishPrompt = resolve; });
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "grounded result" }],
      provider: "test",
      model: "small-model",
      stopReason: "stop",
      timestamp: 2,
    };
    this.emit({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", delta: "grounded result" } });
    this.messages.push(assistant);
    this.emit({ type: "message_end", message: assistant });
    this.isStreaming = false;
    this.emit({ type: "agent_end", messages: this.messages, willRetry: false });
  }

  settle() {
    this.finishPrompt?.();
  }

  async steer(text: string) {
    this.steering.push(text);
    this.pendingMessageCount += 1;
    this.emit({ type: "queue_update", steering: this.steering, followUp: this.followUps });
  }

  async followUp(text: string) {
    this.followUps.push(text);
    this.pendingMessageCount += 1;
    this.emit({ type: "queue_update", steering: this.steering, followUp: this.followUps });
  }

  async abort() {
    this.settle();
    await new Promise((resolve) => setImmediate(resolve));
  }

  setSessionName(name: string) {
    this.sessionName = name;
  }

  availableCommands() {
    return this.commandList;
  }

  dispose() {
    this.disposed = true;
  }
}

function fixture() {
  const sessions = new Map<string, FakePiSession>();
  let sequence = 0;
  const host = createPiAgentHost({
    cwd: "/fixed/workspace",
    clock: () => new Date(Date.UTC(2026, 6, 12, 10, 0, sequence++)).toISOString(),
    maxEvents: 4,
    openSession: async ({ resumeSessionId }) => {
      const id = resumeSessionId ?? `new-${sessions.size + 1}`;
      const session = sessions.get(id) ?? new FakePiSession(id);
      sessions.set(id, session);
      return session;
    },
    listSavedSessions: async () => [{
      sessionId: "saved-1",
      path: "/host-owned/saved-1.jsonl",
      name: "Prior study",
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T12:00:00.000Z",
      messageCount: 8,
    }],
  });
  return { host, sessions };
}

test("Pi adapter opens, resumes, steers, and streams without making activity durable scientific state", async () => {
  const { host, sessions } = fixture();
  try {
    const listed = await host.list();
    assert.deepEqual(listed.map((item) => [item.sessionId, item.state]), [["saved-1", "available"]]);

    const opened = await host.open({ name: "Browser study" });
    assert.equal(opened.sessionId, "new-1");
    assert.equal(opened.name, "Browser study");
    assert.equal(opened.state, "idle");

    const renamed = await host.rename(opened.sessionId, "Rare disease review");
    assert.equal(renamed.name, "Rare disease review");
    assert.deepEqual((await host.commands(opened.sessionId)).commands, sessions.get(opened.sessionId)!.commandList);

    const commandResult = await host.send(opened.sessionId, { delivery: "prompt", text: "/review" });
    assert.equal(commandResult.state, "idle");
    assert.deepEqual(sessions.get(opened.sessionId)!.invokedCommands, ["/review"]);
    assert.equal(sessions.get(opened.sessionId)!.messages.length, 0, "Pi command dispatch bypasses the model transcript");

    const accepted = await host.send(opened.sessionId, { delivery: "prompt", text: "inspect the declared relation" });
    assert.equal(accepted.state, "running", "prompt HTTP acceptance does not wait for the whole agent turn");

    await host.send(opened.sessionId, { delivery: "steer", text: "also inspect missingness" });
    assert.deepEqual(sessions.get(opened.sessionId)!.steering, ["also inspect missingness"]);

    sessions.get(opened.sessionId)!.settle();
    await new Promise((resolve) => setImmediate(resolve));
    const settled = await host.get(opened.sessionId);
    assert.equal(settled?.state, "idle");

    const transcript = await host.transcript(opened.sessionId);
    assert.equal(transcript.messages.length, 2);
    assert.equal((transcript.messages[0] as Record<string, unknown>).role, "user");

    const activity = await host.events(opened.sessionId, 0, 100);
    assert.equal(activity.truncated, true, "cursor zero reports events lost from the bounded ring");
    assert.ok(activity.events[0]!.cursor > 1);
    assert.ok(activity.events.some((event) => event.kind === "agent_end"));
    assert.ok(activity.events.every((event) => !JSON.stringify(event).includes("/host-owned/")));

    const resumed = await host.open({ resumeSessionId: "saved-1" });
    assert.equal(resumed.sessionId, "saved-1");
    assert.equal(resumed.resumable, true);
  } finally {
    await host.dispose();
  }
});

test("agent session HTTP routes validate input and expose bounded host state", async () => {
  const { host, sessions } = fixture();
  const app = createWorkbenchApi({
    agentHost: host,
  });
  try {
    const info = await app.request("/v1/workbench");
    assert.equal(info.status, 200);
    assert.equal((await info.json() as { agentHost: string }).agentHost, "pi");

    const invalid = await app.request("/v1/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeSessionId: "", cwd: "/forbidden" }),
    });
    assert.equal(invalid.status, 400);

    const created = await app.request("/v1/agent-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API study" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as { sessionId: string; name: string };
    assert.equal(session.name, "API study");

    const renamed = await app.request(`/v1/agent-sessions/${session.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API review" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as { name: string }).name, "API review");

    const commands = await app.request(`/v1/agent-sessions/${session.sessionId}/commands`);
    assert.equal(commands.status, 200);
    assert.deepEqual((await commands.json() as { commands: unknown[] }).commands, sessions.get(session.sessionId)!.commandList);

    const sent = await app.request(`/v1/agent-sessions/${session.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "prompt", text: "run the query" }),
    });
    assert.equal(sent.status, 202);

    const conflicting = await app.request(`/v1/agent-sessions/${session.sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delivery: "prompt", text: "start another turn" }),
    });
    assert.equal(conflicting.status, 409);

    const events = await app.request(`/v1/agent-sessions/${session.sessionId}/events?after=0&limit=50`);
    assert.equal(events.status, 200);
    const page = await events.json() as { events: Array<{ kind: string }> };
    assert.ok(page.events.some((event) => event.kind === "agent_start"));

    sessions.get(session.sessionId)!.settle();
    await new Promise((resolve) => setImmediate(resolve));
    const transcript = await app.request(`/v1/agent-sessions/${session.sessionId}/transcript?limit=20`);
    assert.equal(transcript.status, 200);
    assert.equal((await transcript.json() as { messages: unknown[] }).messages.length, 2);

    const closed = await app.request(`/v1/agent-sessions/${session.sessionId}`, { method: "DELETE" });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json(), { closed: true, sessionId: session.sessionId });

    const afterClose = await app.request(`/v1/agent-sessions/${session.sessionId}`);
    assert.equal(afterClose.status, 404);

    const missing = await app.request("/v1/agent-sessions/missing/transcript");
    assert.equal(missing.status, 404);
  } finally {
    await host.dispose();
  }
});
