import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { AgentHarness, BACKGROUND_CONTEXT, type AgentLane, type LaneSnapshot, type WatchHandle } from "@earendil-works/pi-agent-core";
import { reduceLaneSnapshot } from "@earendil-works/pi-agent-core/harness/runtime/reducer";
import type { AgentEvent } from "@pi-bio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import type { ScienceToolRuntime } from "../src/science/client.js";

const services: AgentService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bio-session-"));
  directories.push(dataDir);
  const service = await AgentService.create({
    dataDir,
    science: { status: () => ({ worker: "ready", duckdb: "ready", r: "idle" }), sql: vi.fn(), evalR: vi.fn(), resetR: vi.fn() },
    modelRuntime: { models, model: faux.getModel(), identity: "faux/faux-model" },
  });
  services.push(service);
  return { service, faux };
}

describe("AgentService", () => {
  it("runs tools through AgentHarness v2 and persists the transcript", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("duckdb_sql", { sql: "SELECT 42 AS answer" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The workspace returned 42."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const sql = vi.fn(async () => ({ rowCount: 1, rows: [{ answer: 42 }], truncated: false }));
    const science: ScienceToolRuntime = {
      status: () => ({ worker: "ready", duckdb: "ready", r: "idle" }),
      sql,
      evalR: vi.fn(),
      resetR: vi.fn(),
    };
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bio-agent-"));
    directories.push(dataDir);
    const service = await AgentService.create({
      dataDir,
      science,
      modelRuntime: {
        models,
        model: faux.getModel(),
        identity: "faux/faux-model",
      },
    });
    services.push(service);

    const session = await service.createSession("Harness proof");
    const events: AgentEvent[] = [];
    const unsubscribe = await service.subscribe(session.id, (event) => events.push(event));
    await service.startPrompt(session.id, "Calculate the answer");
    await service.waitForIdle(session.id);

    expect(sql).toHaveBeenCalledWith(
      "SELECT 42 AS answer",
      undefined,
      expect.any(AbortSignal),
    );
    const snapshot = await service.snapshot(session.id);
    expect(snapshot.lastResult?.status).toBe("completed");
    expect(snapshot.stats.usage.totalTokens).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.transcript)).toContain("The workspace returned 42.");
    const evidence = snapshot.transcript.find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    if (evidence?.type !== "message" || evidence.message.role !== "toolResult") {
      throw new Error("Expected a persisted tool result");
    }
    expect(evidence.message.details).toMatchObject({ rows: [{ answer: 42 }] });
    unsubscribe();
    const first = events[0]?.event;
    if (first?.type !== "snapshot") throw new Error("Stream must begin with a snapshot");
    for (const record of events.slice(1)) {
      expect(record.event.type).not.toBe("snapshot");
      if (record.event.type !== "snapshot" && record.event.type !== "application_error") {
        expect(reduceLaneSnapshot(first.snapshot, record.event)).not.toBe("rebase");
      }
    }
    expect(first.snapshot.transcript).toEqual(snapshot.transcript);
    expect(first.snapshot.operation).toBeNull();
    expect(first.snapshot.stats).toEqual(snapshot.stats);
    const reconnected: AgentEvent[] = [];
    (await service.subscribe(session.id, (event) => reconnected.push(event)))();
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]?.event).toEqual({ type: "snapshot", snapshot });
    await expect(Promise.all([service.snapshot(session.id), service.snapshot(session.id)])).resolves.toEqual([snapshot, snapshot]);

    await service.close();
    const reopened = await AgentService.create({ dataDir, science, modelRuntime: { models, model: faux.getModel(), identity: "faux/faux-model" } });
    services.push(reopened);
    const persisted = await reopened.snapshot(session.id);
    expect(persisted.transcript).toEqual(snapshot.transcript);
    expect(persisted.stats).toEqual(snapshot.stats);
  });

  it("publishes the navigation baseline before subsequent lane events", async () => {
    const nativeCreate = AgentHarness.create;
    let lane: AgentLane | undefined;
    let watch: WatchHandle<LaneSnapshot> | undefined;
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async <T extends object | undefined>(...args: Parameters<typeof nativeCreate<T>>) => {
      const result = await nativeCreate<T>(...args);
      lane = await result.harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
      const nativeWatch = lane.watch.bind(lane);
      vi.spyOn(lane, "watch").mockImplementationOnce(async (context) => {
        watch = await nativeWatch(context);
        return watch;
      });
      return result;
    });
    try {
      const { service } = await fixture();
      const session = await service.createSession("Navigation projection");
      createSpy.mockRestore();
      if (!lane || !watch) throw new Error("Expected the service's native lane watch");
      await lane.appendCustomEntry("before_navigation", {}, BACKGROUND_CONTEXT);
      const resnapshot = watch.resnapshot.bind(watch);
      vi.spyOn(watch, "resnapshot").mockImplementationOnce(async (context) => {
        const snapshot = await resnapshot(context);
        captured.resolve();
        await release.promise;
        return snapshot;
      });
      const events: AgentEvent[] = [];
      const unsubscribe = await service.subscribe(session.id, (event) => events.push(event));
      const navigation = lane.navigateTree(null, { summarize: false }, BACKGROUND_CONTEXT);
      await captured.promise;
      await navigation;
      const entryId = await lane.appendCustomEntry("after_navigation", {}, BACKGROUND_CONTEXT);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events.some(({ event }) => event.type === "entry_added" && event.entry.id === entryId)).toBe(false);
      release.resolve();
      await vi.waitFor(() => expect(events.some(({ event }) => event.type === "entry_added" && event.entry.id === entryId)).toBe(true));
      const baseline = events.findIndex(({ event }, index) => index > 0 && event.type === "snapshot");
      const added = events.findIndex(({ event }) => event.type === "entry_added" && event.entry.id === entryId);
      expect(baseline).toBeGreaterThan(0);
      expect(added).toBeGreaterThan(baseline);
      const snapshot = events[baseline]!.event;
      if (snapshot.type !== "snapshot") throw new Error("Expected a replacement snapshot");
      expect(snapshot.snapshot.transcript).toHaveLength(0);
      expect((await service.snapshot(session.id)).transcript.map((entry) => entry.id)).toEqual([entryId]);
      unsubscribe();
    } finally {
      release.resolve();
      vi.restoreAllMocks();
    }
  });

  it("reopens history and draft, and persists an explicit model change", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bio-reopen-"));
    directories.push(dataDir);
    const science: ScienceToolRuntime = {
      status: () => ({ worker: "ready", duckdb: "ready", r: "idle" }),
      sql: vi.fn(), evalR: vi.fn(), resetR: vi.fn(),
    };
    const old = fauxProvider({ provider: "obsolete-provider" });
    old.setResponses([fauxAssistantMessage("Saved before restart.")]);
    const oldModels = createModels();
    oldModels.setProvider(old.provider);
    const first = await AgentService.create({
      dataDir, science,
      modelRuntime: { models: oldModels, model: old.getModel(), identity: "obsolete-provider/faux-model" },
    });
    services.push(first);
    const session = await first.createSession("Durable research");
    await first.startPrompt(session.id, "Remember this conversation");
    await first.waitForIdle(session.id);
    await first.saveDraft(session.id, "Next: inspect the table");
    await first.renameSession(session.id, "Renamed research");
    await first.archiveSession(session.id);
    expect(await first.listSessions()).toEqual([]);
    await first.close();
    services.splice(services.indexOf(first), 1);

    const current = fauxProvider();
    current.setResponses([fauxAssistantMessage("Resumed with the current model.")]);
    const models = createModels();
    models.setProvider(current.provider);
    const resumed = await AgentService.create({
      dataDir, science,
      modelRuntime: { models, model: current.getModel(), identity: "faux/faux-model" },
    });
    services.push(resumed);
    expect(await resumed.listSessions()).toEqual([]);
    expect(await resumed.listSessions(true)).toContainEqual(expect.objectContaining({ id: session.id, name: "Renamed research", archivedAt: expect.any(Number) }));
    await expect(resumed.startPrompt(session.id, "Must not start while archived")).rejects.toThrow("Restore");
    await resumed.restoreSession(session.id);
    expect(await resumed.listSessions()).toContainEqual(expect.objectContaining({ id: session.id, name: "Renamed research" }));
    const saved = await resumed.snapshot(session.id);
    expect(JSON.stringify(saved.transcript)).toContain("Saved before restart.");
    expect(saved.draft).toBe("Next: inspect the table");
    await resumed.selectModel(session.id, { provider: current.getModel().provider, modelId: current.getModel().id });
    await resumed.selectThinking(session.id, "off");
    await expect(resumed.selectThinking(session.id, "invented-level")).rejects.toThrow("Unsupported thinking");
    await resumed.startPrompt(session.id, "Continue");
    await resumed.waitForIdle(session.id);
    const snapshot = await resumed.snapshot(session.id);
    expect(snapshot.lastResult?.status).toBe("completed");
    expect(snapshot.configuration.model?.provider).toBe(current.getModel().provider);
    expect(JSON.stringify(snapshot.transcript)).toContain("Resumed with the current model.");
  });

  it("archives atomically against concurrent prompt admission", async () => {
    const { service } = await fixture();
    const session = await service.createSession();
    const archive = service.archiveSession(session.id);
    const prompt = service.startPrompt(session.id, "Do not run a hidden operation");
    await archive;
    await expect(prompt).rejects.toThrow("Restore");
    expect((await service.snapshot(session.id)).operation).toBeNull();
  });

  it("forks before a selected user message and carries that text into a saved draft", async () => {
    const { service, faux } = await fixture();
    faux.setResponses([fauxAssistantMessage("Original result")]);
    const original = await service.createSession("Original");
    await service.startPrompt(original.id, "Compare two approaches");
    await service.waitForIdle(original.id);
    const snapshot = await service.snapshot(original.id);
    const user = snapshot.transcript.find((entry) => entry.type === "message" && entry.message.role === "user")!;
    const fork = await service.forkSession(original.id, user.id);
    const forked = await service.snapshot(fork.id);
    expect(forked.draft).toBe("Compare two approaches");
    expect(forked.transcript).toHaveLength(0);
    expect(forked.stats.usage.totalTokens).toBe(0);
    expect(fork.parentSessionId).toBe(original.id);
    const clone = await service.forkSession(original.id);
    expect(JSON.stringify((await service.snapshot(clone.id)).transcript)).toContain("Original result");
    const tree = await service.sessionTree(original.id);
    expect(tree.entries.length).toBeGreaterThan(0);
    expect(tree.lanes).toContainEqual(expect.objectContaining({ name: "main" }));
  });

  it("delegates directly to an isolated Harness lane", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", { task: "Inspect the table" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Child analysis completed."),
      fauxAssistantMessage("Parent used the child result."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const science: ScienceToolRuntime = {
      status: () => ({ worker: "ready", duckdb: "ready", r: "idle" }),
      sql: vi.fn(),
      evalR: vi.fn(),
      resetR: vi.fn(),
    };
    const dataDir = await mkdtemp(join(tmpdir(), "pi-bio-delegate-"));
    directories.push(dataDir);
    const service = await AgentService.create({
      dataDir,
      science,
      modelRuntime: {
        models,
        model: faux.getModel(),
        identity: "faux/faux-model",
      },
    });
    services.push(service);

    const session = await service.createSession("Direct RLM proof");
    await service.startPrompt(session.id, "Delegate this analysis");
    await service.waitForIdle(session.id);

    const snapshot = await service.snapshot(session.id);
    const transcript = JSON.stringify(snapshot.transcript);
    expect(transcript).toContain("Child analysis completed.");
    expect(transcript).toContain("Parent used the child result.");
    expect(transcript).toContain("rlm-");
  });
});
