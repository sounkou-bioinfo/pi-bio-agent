import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  type AgentHarness as AgentHarnessInstance,
  type AgentLane,
  type JsonlSessionMetadata,
  type Session,
  type WatchHandle,
  type LaneSnapshot,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentEvent, SessionSummary } from "@pi-bio/protocol";
import type { ScienceToolRuntime } from "./science/client.js";
import { createHarnessTools, type AppToolContext } from "./tools.js";

const SYSTEM_PROMPT = `You are Pi Bio, a scientific analysis agent.

Use tools for every biomedical or numerical claim. DuckDB is the durable scientific workspace. R is a persistent scratch interpreter reached through nanonext/NNG; materialize important results into DuckDB or files because the R heap is not durable. Use delegate for one bounded, isolated Harness child lane when independent analysis is useful.

Return concise answers with the SQL, R code, table names, and tool evidence needed to reproduce them. Never invent biomedical facts or claim that ephemeral interpreter state survived a restart.`;

export interface ModelRuntime {
  models: Models;
  model: Model<Api>;
  identity: string;
}

export interface AgentServiceOptions {
  dataDir: string;
  science: ScienceToolRuntime;
  modelRuntime?: ModelRuntime;
}

interface Runtime {
  metadata: JsonlSessionMetadata;
  session: Session<JsonlSessionMetadata>;
  harness: AgentHarnessInstance<AppToolContext>;
  lane: AgentLane;
  watch: WatchHandle<LaneSnapshot>;
  events: SessionEvents;
  drives: Set<Promise<void>>;
  drivingIds: Set<string>;
}

export class AgentService {
  readonly modelIdentity: string;
  readonly #repo: JsonlSessionRepo;
  readonly #science: ScienceToolRuntime;
  readonly #modelRuntime: ModelRuntime;
  readonly #runtimes = new Map<string, Promise<Runtime>>();

  private constructor(options: AgentServiceOptions, repo: JsonlSessionRepo, modelRuntime: ModelRuntime) {
    this.#repo = repo;
    this.#science = options.science;
    this.#modelRuntime = modelRuntime;
    this.modelIdentity = modelRuntime.identity;
  }

  static async create(options: AgentServiceOptions): Promise<AgentService> {
    const sessionsRoot = join(options.dataDir, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const modelRuntime = options.modelRuntime ?? modelRuntimeFromEnvironment();
    const repo = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessionsRoot,
    });
    return new AgentService(options, repo, modelRuntime);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const metadata = await this.#repo.list(undefined, BACKGROUND_CONTEXT);
    return Promise.all(
      metadata.map(async (item) => {
        const runtime = await this.#runtime(item.id);
        const name = (await runtime.harness.getName(BACKGROUND_CONTEXT)) ?? `Analysis ${item.id.slice(0, 8)}`;
        return summary(item, name);
      }),
    );
  }

  async createSession(name?: string): Promise<SessionSummary> {
    const id = randomUUID();
    const session = await this.#repo.create(
      { id, cwd: process.cwd() },
      BACKGROUND_CONTEXT,
    );
    const runtimePromise = this.#attach(session);
    this.#runtimes.set(id, runtimePromise);
    const runtime = await runtimePromise;
    const resolvedName = name?.trim() || `Analysis ${id.slice(0, 8)}`;
    await runtime.harness.setName(resolvedName, BACKGROUND_CONTEXT);
    return summary(runtime.metadata, resolvedName);
  }

  async snapshot(id: string): Promise<LaneSnapshot> {
    const runtime = await this.#runtime(id);
    return runtime.watch.resnapshot(BACKGROUND_CONTEXT);
  }

  async startPrompt(id: string, prompt: string): Promise<string> {
    const runtime = await this.#runtime(id);
    const operationId = randomUUID();
    const admission = await runtime.lane.accept(
      { kind: "prompt", operationId, prompt },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw admission.error;
    this.#trackDrive(runtime, runtime.lane, operationId);
    return operationId;
  }

  async abort(id: string): Promise<void> {
    const runtime = await this.#runtime(id);
    const result = await runtime.lane.abort(BACKGROUND_CONTEXT);
    if (!result.ok) throw result.error;
  }

  async waitForIdle(id: string): Promise<void> {
    const runtime = await this.#runtime(id);
    await Promise.all([...runtime.drives]);
  }

  async subscribe(
    id: string,
    after: number,
    listener: (event: AgentEvent) => void,
  ): Promise<() => void> {
    const runtime = await this.#runtime(id);
    return runtime.events.subscribe(after, listener);
  }

  async close(): Promise<void> {
    const runtimes = await Promise.allSettled([...this.#runtimes.values()]);
    for (const settled of runtimes) {
      if (settled.status !== "fulfilled") continue;
      const runtime = settled.value;
      for (const laneInfo of await runtime.harness.lanes(BACKGROUND_CONTEXT)) {
        if (laneInfo.operation === null) continue;
        const lane = await runtime.harness.lane(laneInfo.name, BACKGROUND_CONTEXT);
        await lane.abort(BACKGROUND_CONTEXT);
      }
      runtime.watch.unsubscribe();
      await Promise.race([
        Promise.allSettled([...runtime.drives]),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      await runtime.harness.close(BACKGROUND_CONTEXT);
    }
    this.#runtimes.clear();
  }

  async #runtime(id: string): Promise<Runtime> {
    const current = this.#runtimes.get(id);
    if (current !== undefined) return current;
    const runtime = this.#openRuntime(id);
    this.#runtimes.set(id, runtime);
    try {
      return await runtime;
    } catch (error) {
      if (this.#runtimes.get(id) === runtime) this.#runtimes.delete(id);
      throw error;
    }
  }

  async #openRuntime(id: string): Promise<Runtime> {
    const metadata = (await this.#repo.list(undefined, BACKGROUND_CONTEXT)).find(
      (item) => item.id === id,
    );
    if (metadata === undefined) throw new Error(`Unknown session: ${id}`);
    const session = await this.#repo.open(metadata, BACKGROUND_CONTEXT);
    return this.#attach(session);
  }

  async #attach(session: Session<JsonlSessionMetadata>): Promise<Runtime> {
    const toolContext: AppToolContext = {
      science: this.#science,
      rScope: session.metadata.id,
    };
    const { harness, open } = await AgentHarness.create<AppToolContext>(
      {
        session,
        models: this.#modelRuntime.models,
        model: this.#modelRuntime.model,
        tools: createHarnessTools(),
        toolContext,
        systemPrompt: SYSTEM_PROMPT,
      },
      BACKGROUND_CONTEXT,
    );
    toolContext.harness = harness;
    const lane = await harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
    const watch = await lane.watch(BACKGROUND_CONTEXT);
    const events = new SessionEvents(session.metadata.id);
    watch.start((event) => events.publish(event));
    const runtime: Runtime = {
      metadata: session.metadata,
      session,
      harness,
      lane,
      watch,
      events,
      drives: new Set(),
      drivingIds: new Set(),
    };
    const mainOperation = open.find((operation) => operation.lane === "main");
    if (mainOperation !== undefined) {
      const mainDrive = this.#trackDrive(runtime, lane, mainOperation.operationId);
      void mainDrive
        .then(() => this.#resumeOpenOperations(runtime, new Set(["main"])))
        .catch((error: unknown) =>
          runtime.events.publish({
            type: "application_error",
            operationId: mainOperation.operationId,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    } else {
      await this.#resumeOpenOperations(runtime, new Set());
    }
    return runtime;
  }

  async #resumeOpenOperations(runtime: Runtime, excludedLanes: Set<string>): Promise<void> {
    for (const laneInfo of await runtime.harness.lanes(BACKGROUND_CONTEXT)) {
      if (laneInfo.operation === null || excludedLanes.has(laneInfo.name)) continue;
      const openLane = await runtime.harness.lane(laneInfo.name, BACKGROUND_CONTEXT);
      this.#trackDrive(runtime, openLane, laneInfo.operation.id);
    }
  }

  #trackDrive(runtime: Runtime, lane: AgentLane, operationId: string): Promise<void> {
    if (runtime.drivingIds.has(operationId)) return Promise.resolve();
    runtime.drivingIds.add(operationId);
    const drive = this.#drive({ ...runtime, lane }, operationId);
    runtime.drives.add(drive);
    void drive.then(() => {
      runtime.drives.delete(drive);
      runtime.drivingIds.delete(operationId);
    });
    return drive;
  }

  async #drive(runtime: Runtime, operationId: string): Promise<void> {
    try {
      for (;;) {
        const result = await runtime.lane.drive(
          { operationId, waitForRetry: true, pollDeferred: true },
          BACKGROUND_CONTEXT,
        );
        if (!result.ok) throw result.error;
        if (result.value.kind === "settled") return;
      }
    } catch (error) {
      runtime.events.publish({
        type: "application_error",
        operationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

class SessionEvents {
  readonly #sessionId: string;
  readonly #history: AgentEvent[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #sequence = Date.now() * 1_000;

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  publish(event: unknown): void {
    const record: AgentEvent = {
      sequence: ++this.#sequence,
      sessionId: this.#sessionId,
      event: jsonSafe(event),
    };
    this.#history.push(record);
    if (this.#history.length > 500) this.#history.shift();
    for (const listener of this.#listeners) listener(record);
  }

  subscribe(after: number, listener: (event: AgentEvent) => void): () => void {
    for (const event of this.#history) {
      if (event.sequence > after) listener(event);
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export function modelRuntimeFromEnvironment(): ModelRuntime {
  const identity = process.env.PI_BIO_MODEL?.trim() || "openai/gpt-5.4";
  const separator = identity.indexOf("/");
  if (separator <= 0 || separator === identity.length - 1) {
    throw new Error("PI_BIO_MODEL must have the form provider/model-id");
  }
  const provider = identity.slice(0, separator);
  const modelId = identity.slice(separator + 1);
  const models = builtinModels();
  const model = models.getModel(provider, modelId);
  if (model === undefined) throw new Error(`Unknown Pi model: ${identity}`);
  return { models, model, identity };
}

function summary(metadata: JsonlSessionMetadata, name: string): SessionSummary {
  return {
    id: metadata.id,
    name,
    createdAt: metadata.createdAt,
    modifiedAt: metadata.modifiedAt,
  };
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
}
