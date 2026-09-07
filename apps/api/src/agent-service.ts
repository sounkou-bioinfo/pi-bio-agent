import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHarness,
  reduceLaneSnapshot,
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
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AgentEvent,
  ModelSelection,
  SessionTree,
  SessionSummary,
  WorkspaceSnapshot,
} from "@pi-bio/protocol";
import { CredentialService } from "./credential-service.js";
import { PiFileCredentialStore } from "./credential-store.js";
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
  rebase?: Promise<void>;
  drivingIds: Set<string>;
}

export class AgentService {
  readonly modelIdentity: string;
  readonly credentials: CredentialService;
  readonly #repo: JsonlSessionRepo;
  readonly #workspaceDb: DatabaseSync;
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #science: ScienceToolRuntime;
  readonly #modelRuntime: ModelRuntime;
  readonly #runtimes = new Map<string, Promise<Runtime>>();

  private constructor(options: AgentServiceOptions, repo: JsonlSessionRepo, modelRuntime: ModelRuntime) {
    this.#repo = repo;
    this.#science = options.science;
    this.#modelRuntime = modelRuntime;
    this.modelIdentity = modelRuntime.identity;
    this.credentials = new CredentialService(modelRuntime.models);
    this.#workspaceDb = new DatabaseSync(join(options.dataDir, "workspace.sqlite"));
    this.#workspaceDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS app_drafts (
        session_id TEXT PRIMARY KEY,
        text TEXT NOT NULL CHECK (length(text) <= 100000)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS app_archived_sessions (
        session_id TEXT PRIMARY KEY,
        archived_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  static async create(options: AgentServiceOptions): Promise<AgentService> {
    const sessionsRoot = join(options.dataDir, "sessions");
    await mkdir(sessionsRoot, { recursive: true });
    const modelRuntime = options.modelRuntime ?? defaultModelRuntime();
    const repo = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: process.cwd() }),
      sessionsRoot,
    });
    return new AgentService(options, repo, modelRuntime);
  }

  async listSessions(archived = false): Promise<SessionSummary[]> {
    const metadata = await this.#repo.list(undefined, BACKGROUND_CONTEXT);
    const hidden = new Map(this.#workspaceDb.prepare("SELECT session_id, archived_at FROM app_archived_sessions").all().map((row) => [String(row.session_id), Number(row.archived_at)]));
    return Promise.all(
      metadata.filter((item) => hidden.has(item.id) === archived).map(async (item) => {
        const runtime = await this.#runtime(item.id);
        const name = (await runtime.harness.getName(BACKGROUND_CONTEXT)) ?? `Analysis ${item.id.slice(0, 8)}`;
        return { ...summary(item, name), ...(hidden.has(item.id) ? { archivedAt: hidden.get(item.id)! } : {}) };
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
    const resolvedName = name?.trim() || "New analysis";
    await runtime.harness.setName(resolvedName, BACKGROUND_CONTEXT);
    return summary(runtime.metadata, resolvedName);
  }

  async archiveSession(id: string): Promise<void> {
    await this.#admit(id, async () => {
      const runtime = await this.#runtime(id);
      const lanes = await runtime.harness.lanes(BACKGROUND_CONTEXT);
      if (lanes.some((lane) => lane.operation !== null)) throw new Error("Stop the running analysis before archiving");
      this.#workspaceDb.prepare("INSERT INTO app_archived_sessions (session_id, archived_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING").run(id, Date.now());
    });
  }

  async restoreSession(id: string): Promise<void> {
    await this.#admit(id, async () => {
      await this.#runtime(id);
      this.#workspaceDb.prepare("DELETE FROM app_archived_sessions WHERE session_id = ?").run(id);
    });
  }

  async renameSession(id: string, name: string): Promise<void> {
    await this.#admit(id, async () => {
      const runtime = await this.#runtime(id);
      if (!name.trim()) throw new Error("Session name cannot be empty");
      await runtime.harness.setName(name.trim(), BACKGROUND_CONTEXT);
    });
  }

  async forkSession(id: string, entryId?: string): Promise<SessionSummary> {
    return this.#admit(id, async () => {
      const runtime = await this.#runtime(id);
      const lanes = await runtime.harness.lanes(BACKGROUND_CONTEXT);
      if (lanes.some((lane) => lane.operation !== null)) throw new Error("Stop the running analysis before forking");
      let draft = "";
      if (entryId !== undefined) {
        const entry = await runtime.session.getEntry(entryId, BACKGROUND_CONTEXT);
        if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("Choose a user message to fork from");
        draft = typeof entry.message.content === "string" ? entry.message.content : entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      }
      const session = await this.#repo.fork(runtime.metadata, { scope: "branch", branch: "main", ...(entryId ? { entryId, position: "before" as const } : {}) }, BACKGROUND_CONTEXT);
      const attached = this.#attach(session);
      this.#runtimes.set(session.metadata.id, attached);
      const fork = await attached;
      const name = `${await runtime.harness.getName(BACKGROUND_CONTEXT) ?? "Analysis"} — ${entryId ? "fork" : "copy"}`;
      await fork.harness.setName(name, BACKGROUND_CONTEXT);
      if (entryId !== undefined) await this.saveDraft(session.metadata.id, draft);
      return summary(session.metadata, name);
    });
  }

  async sessionTree(id: string, cursor?: number): Promise<SessionTree> {
    const runtime = await this.#runtime(id);
    const entries = await runtime.session.findEntries({ order: "desc", limit: 200, ...(cursor === undefined ? {} : { cursor: { seq: cursor } }) }, BACKGROUND_CONTEXT);
    const lanes = await runtime.harness.lanes(BACKGROUND_CONTEXT);
    return {
      entries: entries.map((entry) => ({
        id: entry.id, parentId: entry.parentId, seq: entry.seq,
        label: entry.type === "message" && "content" in entry.message
          ? `${entry.message.role}: ${typeof entry.message.content === "string" ? entry.message.content.slice(0, 100) : entry.message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 100)}`
          : entry.type,
      })),
      lanes: lanes.map((lane) => ({ name: lane.name, tipId: lane.tipId })),
      ...(entries.length === 200 ? { nextCursor: entries[entries.length - 1]!.seq } : {}),
    };
  }

  async snapshot(id: string): Promise<WorkspaceSnapshot> {
    return this.#snapshot(await this.#runtime(id));
  }

  #snapshot(runtime: Runtime): WorkspaceSnapshot {
    const stored = this.#workspaceDb.prepare("SELECT text FROM app_drafts WHERE session_id = ?").get(runtime.metadata.id);
    return { ...jsonSafe(runtime.watch.snapshot) as LaneSnapshot, draft: typeof stored?.text === "string" ? stored.text : "", eventCursor: runtime.events.sequence };
  }

  async saveDraft(id: string, text: string): Promise<void> {
    await this.#runtime(id);
    this.#workspaceDb.prepare(`
      INSERT INTO app_drafts (session_id, text) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET text = excluded.text
    `).run(id, text);
  }

  async selectModel(id: string, selection: ModelSelection): Promise<void> {
    await this.#admit(id, async () => {
      const runtime = await this.#runtime(id);
      const model = this.#modelRuntime.models.getModel(selection.provider, selection.modelId);
      if (model === undefined) throw new Error("This model is not in Pi's catalog");
      const level = await runtime.lane.getThinkingLevel(BACKGROUND_CONTEXT);
      await runtime.lane.setModel(selection, BACKGROUND_CONTEXT);
      await runtime.lane.setThinkingLevel(clampThinkingLevel(model, level), BACKGROUND_CONTEXT);
    });
  }

  async selectThinking(id: string, level: string): Promise<void> {
    await this.#admit(id, async () => {
      const runtime = await this.#runtime(id);
      const model = await runtime.lane.getModel(BACKGROUND_CONTEXT);
      const supported = model && getSupportedThinkingLevels(model).find((candidate) => candidate === level);
      if (supported === undefined) throw new Error("Unsupported thinking level for the selected model");
      await runtime.lane.setThinkingLevel(supported, BACKGROUND_CONTEXT);
    });
  }

  async startPrompt(id: string, prompt: string): Promise<string> {
    return this.#admit(id, () => this.#startPrompt(id, prompt));
  }

  async #startPrompt(id: string, prompt: string): Promise<string> {
    if (this.#workspaceDb.prepare("SELECT 1 FROM app_archived_sessions WHERE session_id = ?").get(id)) {
      throw new Error("Restore the archived session before continuing");
    }
    const runtime = await this.#runtime(id);
    const name = await runtime.harness.getName(BACKGROUND_CONTEXT);
    if (name === "New analysis" || name === `Analysis ${id.slice(0, 8)}`) {
      await runtime.harness.setName(prompt.replace(/\s+/g, " ").slice(0, 70), BACKGROUND_CONTEXT);
    }
    const operationId = randomUUID();
    const admission = await runtime.lane.accept(
      { kind: "prompt", operationId, prompt },
      BACKGROUND_CONTEXT,
    );
    if (!admission.ok) throw admission.error;
    this.#trackDrive(runtime, runtime.lane, operationId);
    return operationId;
  }

  #admit<T>(id: string, action: () => Promise<T>): Promise<T> {
    // Coordinate app metadata/configuration with Pi admission in this API host.
    const result = (this.#admissions.get(id) ?? Promise.resolve()).then(action);
    const settled = result.then(() => undefined, () => undefined);
    this.#admissions.set(id, settled);
    void settled.then(() => { if (this.#admissions.get(id) === settled) this.#admissions.delete(id); });
    return result;
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
    listener: (event: AgentEvent) => void,
  ): Promise<() => void> {
    const runtime = await this.#runtime(id);
    return runtime.events.subscribe(listener);
  }

  async close(): Promise<void> {
    await Promise.all(this.#admissions.values());
    const runtimes = await Promise.allSettled([...this.#runtimes.values()]);
    for (const settled of runtimes) {
      if (settled.status !== "fulfilled") continue;
      const runtime = settled.value;
      for (const laneInfo of await runtime.harness.lanes(BACKGROUND_CONTEXT)) {
        if (laneInfo.operation === null) continue;
        const lane = await runtime.harness.lane(laneInfo.name, BACKGROUND_CONTEXT);
        await lane.abort(BACKGROUND_CONTEXT);
      }
      await runtime.rebase;
      runtime.watch.unsubscribe();
      await Promise.race([
        Promise.allSettled([...runtime.drives]),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      await runtime.harness.close(BACKGROUND_CONTEXT);
    }
    this.#runtimes.clear();
    await this.credentials.close();
    if (this.#workspaceDb.isOpen) this.#workspaceDb.close();
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
        thinkingLevel: this.#modelRuntime.model.reasoning ? "medium" : "off",
        tools: createHarnessTools(),
        toolContext,
        systemPrompt: SYSTEM_PROMPT,
      },
      BACKGROUND_CONTEXT,
    );
    toolContext.harness = harness;
    const lane = await harness.lane("main", { createAt: null }, BACKGROUND_CONTEXT);
    const watch = await lane.watch(BACKGROUND_CONTEXT);
    const events = new SessionEvents(session.metadata.id, () => this.#snapshot(runtime));
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
    watch.start(async (event) => {
      const reduction = reduceLaneSnapshot(watch.snapshot, event);
      if (reduction === "rebase") {
        runtime.rebase = watch.resnapshot(BACKGROUND_CONTEXT).then(() => {
          events.publish({ type: "snapshot", snapshot: this.#snapshot(runtime) });
        }).catch((error: unknown) => {
          events.publish({ type: "application_error", operationId: "rebase", message: error instanceof Error ? error.message : String(error) });
        }).finally(() => { delete runtime.rebase; });
        // The watch has its own serial delivery queue; held events must follow this baseline.
        await runtime.rebase;
      } else events.publish(event);
    });
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
  readonly #snapshot: () => WorkspaceSnapshot;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #sequence = Date.now() * 1_000;

  constructor(sessionId: string, snapshot: () => WorkspaceSnapshot) {
    this.#sessionId = sessionId;
    this.#snapshot = snapshot;
  }

  get sequence(): number { return this.#sequence; }

  publish(event: AgentEvent["event"]): void {
    const record: AgentEvent = {
      sequence: ++this.#sequence,
      sessionId: this.#sessionId,
      event: jsonSafe(event) as AgentEvent["event"],
    };
    for (const listener of this.#listeners) listener(record);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    // Install the listener and capture its baseline in one synchronous turn.
    listener({ sequence: this.#sequence, sessionId: this.#sessionId, event: { type: "snapshot", snapshot: this.#snapshot() } });
    return () => this.#listeners.delete(listener);
  }
}

export function defaultModelRuntime(): ModelRuntime {
  const modelId = "gpt-5.6-sol";
  const models = builtinModels({ credentials: new PiFileCredentialStore() });
  const model = models.getModel("openai-codex", modelId);
  if (model === undefined) throw new Error(`Pi does not provide openai-codex/${modelId}`);
  return { models, model, identity: `openai-codex/${modelId}` };
}

function summary(metadata: JsonlSessionMetadata, name: string): SessionSummary {
  return {
    id: metadata.id,
    name,
    createdAt: metadata.createdAt,
    modifiedAt: metadata.modifiedAt,
    ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
  };
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
}
