import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import type { ScienceToolRuntime } from "../src/science/client.js";

const services: AgentService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
    await service.startPrompt(session.id, "Calculate the answer");
    await service.waitForIdle(session.id);

    expect(sql).toHaveBeenCalledWith(
      "SELECT 42 AS answer",
      undefined,
      expect.any(AbortSignal),
    );
    const snapshot = await service.snapshot(session.id);
    expect(snapshot.lastResult?.status).toBe("completed");
    expect(JSON.stringify(snapshot.transcript)).toContain("The workspace returned 42.");
    const evidence = snapshot.transcript.find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    if (evidence?.type !== "message" || evidence.message.role !== "toolResult") {
      throw new Error("Expected a persisted tool result");
    }
    expect(evidence.message.details).toMatchObject({ rows: [{ answer: 42 }] });
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
