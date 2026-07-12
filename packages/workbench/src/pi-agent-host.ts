import { canonicalDigest } from "pi-bio-agent";
import type { JsonValue } from "pi-bio-agent";
import {
  AgentSessionConflictError,
  AgentSessionNotFoundError,
  type AgentActivityEvent,
  type AgentCommandSummary,
  type AgentHostPort,
  type AgentSessionSummary,
} from "./agent-host.js";

interface PiSessionLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly model?: { provider: string; id: string };
  readonly thinkingLevel?: string;
  readonly isStreaming: boolean;
  readonly pendingMessageCount: number;
  readonly messages: unknown[];
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: {
    streamingBehavior?: "steer" | "followUp";
    source?: "interactive" | "rpc" | "extension";
    preflightResult?: (success: boolean) => void;
  }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  setSessionName(name: string): void;
  availableCommands?(): AgentCommandSummary[];
  dispose(): void;
}

export interface SavedPiSession {
  sessionId: string;
  path: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface PiAgentHostOptions {
  cwd: string;
  sessionDir?: string;
  extensionPaths?: string[];
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
  maxEvents?: number;
  maxEventBytes?: number;
  clock?: () => string;
  /** Test/deployment seam. The default implementation embeds Pi through its public SDK. */
  openSession?: (request: { resumeSessionId?: string }) => Promise<PiSessionLike>;
  /** Test/deployment seam paired with openSession. */
  listSavedSessions?: () => Promise<SavedPiSession[]>;
}

interface ActivePiSession {
  session: PiSessionLike;
  openedAt: string;
  updatedAt: string;
  events: AgentActivityEvent[];
  nextCursor: number;
  listeners: Set<(event: AgentActivityEvent) => void>;
  unsubscribe: () => void;
  lastError?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  return trimmed;
}

function normalizeLimit(value: number | undefined, fallback: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
  return value;
}

function normalizeCursor(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new Error("event cursor must be a non-negative integer");
  return value;
}

function jsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { type: "bytes", encoding: "base64", data: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return { circular: true };
    seen.add(value);
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "undefined" && typeof item !== "function" && typeof item !== "symbol") out[key] = jsonValue(item, seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

function boundedJsonValue(value: unknown, maxBytes: number): JsonValue {
  const normalized = jsonValue(value);
  const encoded = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= maxBytes) return normalized;
  return {
    truncated: true,
    digest: canonicalDigest(normalized),
    bytes,
    preview: encoded.slice(0, Math.min(2_000, maxBytes)),
  };
}

function eventKind(event: unknown): string {
  if (event && typeof event === "object" && "type" in event && typeof event.type === "string" && event.type.trim()) return event.type;
  return "host_event";
}

function projectPiEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return { value: event };
  const input = event as Record<string, unknown>;
  switch (input.type) {
    case "agent_end":
      return { type: input.type, willRetry: input.willRetry ?? false, messageCount: Array.isArray(input.messages) ? input.messages.length : 0 };
    case "turn_end":
      return { type: input.type, message: input.message, toolResultCount: Array.isArray(input.toolResults) ? input.toolResults.length : 0 };
    case "message_update":
      return { type: input.type, assistantMessageEvent: input.assistantMessageEvent };
    case "queue_update":
      return {
        type: input.type,
        steeringCount: Array.isArray(input.steering) ? input.steering.length : 0,
        followUpCount: Array.isArray(input.followUp) ? input.followUp.length : 0,
      };
    default:
      return input;
  }
}

async function defaultSavedSessions(options: PiAgentHostOptions): Promise<SavedPiSession[]> {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessions = await SessionManager.list(options.cwd, options.sessionDir);
  return sessions.map((session) => ({
    sessionId: session.id,
    path: session.path,
    ...(session.name ? { name: session.name } : {}),
    createdAt: session.created.toISOString(),
    updatedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
  }));
}

async function defaultOpenSession(options: PiAgentHostOptions, request: { resumeSessionId?: string }): Promise<PiSessionLike> {
  const pi = await import("@earendil-works/pi-coding-agent");
  let sessionManager: ReturnType<typeof pi.SessionManager.create>;
  if (request.resumeSessionId) {
    const saved = await defaultSavedSessions(options);
    const match = saved.find((session) => session.sessionId === request.resumeSessionId);
    if (!match) throw new AgentSessionNotFoundError(request.resumeSessionId);
    sessionManager = pi.SessionManager.open(match.path, options.sessionDir, options.cwd);
  } else {
    sessionManager = pi.SessionManager.create(options.cwd, options.sessionDir);
  }

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: pi.getAgentDir(),
    additionalExtensionPaths: options.extensionPaths ?? [],
  });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    sessionManager,
    resourceLoader,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
    ...(options.noTools ? { noTools: options.noTools } : {}),
  });
  const commandSession = session as typeof session & { availableCommands?: () => AgentCommandSummary[] };
  commandSession.availableCommands = () => {
    const extensionCommands = session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      ...(command.description ? { description: command.description } : {}),
      source: "extension" as const,
    }));
    const prompts = session.promptTemplates.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description ? { description: prompt.description } : {}),
      source: "prompt" as const,
    }));
    const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
      name: `skill:${skill.name}`,
      ...(skill.description ? { description: skill.description } : {}),
      source: "skill" as const,
    }));
    return [...extensionCommands, ...prompts, ...skills];
  };
  return commandSession;
}

export function createPiAgentHost(options: PiAgentHostOptions): AgentHostPort {
  const clock = options.clock ?? nowIso;
  const maxEvents = normalizeLimit(options.maxEvents, 1_000, 10_000, "maxEvents");
  const maxEventBytes = normalizeLimit(options.maxEventBytes, 128_000, 2_000_000, "maxEventBytes");
  const active = new Map<string, ActivePiSession>();
  const openSession = options.openSession ?? ((request) => defaultOpenSession(options, request));
  const listSaved = options.listSavedSessions ?? (() => defaultSavedSessions(options));

  function requireActive(sessionId: string): ActivePiSession {
    const id = nonEmpty(sessionId, "sessionId");
    const entry = active.get(id);
    if (!entry) throw new AgentSessionNotFoundError(id);
    return entry;
  }

  function append(entry: ActivePiSession, kind: string, payload: unknown): AgentActivityEvent {
    const event: AgentActivityEvent = {
      cursor: entry.nextCursor++,
      at: clock(),
      kind,
      payload: boundedJsonValue(payload, maxEventBytes),
    };
    entry.updatedAt = event.at;
    entry.events.push(event);
    if (entry.events.length > maxEvents) entry.events.splice(0, entry.events.length - maxEvents);
    for (const listener of entry.listeners) listener(event);
    return event;
  }

  function summary(entry: ActivePiSession): AgentSessionSummary {
    const session = entry.session;
    return {
      sessionId: session.sessionId,
      host: "pi",
      state: session.isStreaming ? "running" : "idle",
      ...(session.sessionName ? { name: session.sessionName } : {}),
      ...(session.model ? { model: { provider: session.model.provider, id: session.model.id } } : {}),
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      resumable: Boolean(session.sessionFile),
      createdAt: entry.openedAt,
      updatedAt: entry.updatedAt,
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
    };
  }

  async function sendPrompt(entry: ActivePiSession, text: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const accept = (success: boolean) => {
        if (settled) return;
        settled = true;
        if (success) resolve();
        else reject(new Error("Pi rejected the prompt before agent execution"));
      };
      const running = entry.session.prompt(text, { source: "rpc", preflightResult: accept });
      void running.then(() => accept(true)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        entry.lastError = message;
        append(entry, "host_error", { operation: "prompt", message });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  return {
    kind: "pi",

    async list() {
      const saved = await listSaved();
      const byId = new Map<string, AgentSessionSummary>();
      for (const session of saved) {
        byId.set(session.sessionId, {
          sessionId: session.sessionId,
          host: "pi",
          state: "available",
          ...(session.name ? { name: session.name } : {}),
          messageCount: session.messageCount,
          pendingMessageCount: 0,
          resumable: true,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
      }
      for (const entry of active.values()) byId.set(entry.session.sessionId, summary(entry));
      return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async open(request = {}) {
      const resumeSessionId = request.resumeSessionId?.trim();
      if (resumeSessionId && active.has(resumeSessionId)) return summary(active.get(resumeSessionId)!);
      const session = await openSession({ ...(resumeSessionId ? { resumeSessionId } : {}) });
      if (active.has(session.sessionId)) return summary(active.get(session.sessionId)!);
      const openedAt = clock();
      const entry: ActivePiSession = {
        session,
        openedAt,
        updatedAt: openedAt,
        events: [],
        nextCursor: 1,
        listeners: new Set(),
        unsubscribe: () => {},
      };
      entry.unsubscribe = session.subscribe((event) => append(entry, eventKind(event), projectPiEvent(event)));
      active.set(session.sessionId, entry);
      if (request.name?.trim()) session.setSessionName(request.name.trim());
      append(entry, "session_opened", { resumed: Boolean(resumeSessionId), host: "pi" });
      return summary(entry);
    },

    async get(sessionId) {
      const entry = active.get(sessionId);
      return entry ? summary(entry) : undefined;
    },

    async rename(sessionId, name) {
      const entry = requireActive(sessionId);
      const nextName = nonEmpty(name, "session name");
      entry.session.setSessionName(nextName);
      append(entry, "session_renamed", { name: nextName });
      return summary(entry);
    },

    async commands(sessionId) {
      const entry = requireActive(sessionId);
      return {
        sessionId: entry.session.sessionId,
        commands: entry.session.availableCommands?.() ?? [],
      };
    },

    async send(sessionId, request) {
      const entry = requireActive(sessionId);
      const text = nonEmpty(request.text, "message text");
      if (request.delivery === "prompt") {
        if (entry.session.isStreaming) throw new AgentSessionConflictError("prompt requires an idle agent session; use steer or follow_up while it is running");
        delete entry.lastError;
        await sendPrompt(entry, text);
      } else if (request.delivery === "steer") {
        if (!entry.session.isStreaming) throw new AgentSessionConflictError("steer requires a running agent session");
        await entry.session.steer(text);
      } else if (request.delivery === "follow_up") {
        if (!entry.session.isStreaming) throw new AgentSessionConflictError("follow_up requires a running agent session");
        await entry.session.followUp(text);
      } else throw new Error(`unsupported agent delivery '${String(request.delivery)}'`);
      return summary(entry);
    },

    async abort(sessionId) {
      const entry = requireActive(sessionId);
      await entry.session.abort();
      return summary(entry);
    },

    async transcript(sessionId, limit) {
      const entry = requireActive(sessionId);
      const take = normalizeLimit(limit, 100, 500, "transcript limit");
      const omittedCount = Math.max(0, entry.session.messages.length - take);
      return {
        sessionId: entry.session.sessionId,
        messages: entry.session.messages.slice(-take).map((message) => boundedJsonValue(message, maxEventBytes)),
        omittedCount,
      };
    },

    async events(sessionId, after, limit) {
      const entry = requireActive(sessionId);
      const cursor = normalizeCursor(after);
      const take = normalizeLimit(limit, 200, 1_000, "event limit");
      const firstRetained = entry.events[0]?.cursor ?? entry.nextCursor;
      const events = entry.events.filter((event) => event.cursor > cursor).slice(0, take);
      return {
        sessionId: entry.session.sessionId,
        events,
        nextCursor: events.at(-1)?.cursor ?? cursor,
        truncated: cursor < firstRetained - 1,
      };
    },

    subscribe(sessionId, listener) {
      const entry = requireActive(sessionId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },

    async close(sessionId) {
      const entry = requireActive(sessionId);
      entry.unsubscribe();
      entry.listeners.clear();
      entry.session.dispose();
      active.delete(sessionId);
    },

    async dispose() {
      for (const entry of active.values()) {
        entry.unsubscribe();
        entry.listeners.clear();
        entry.session.dispose();
      }
      active.clear();
    },
  };
}
