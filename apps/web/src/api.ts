import type {
  AgentEvent,
  PromptAccepted,
  RuntimeStatus,
  SessionSummary,
} from "@pi-bio/protocol";

declare global {
  interface Window {
    piBio?: { apiBase: string; token: string };
  }
}

export interface LaneSnapshot {
  transcript: TranscriptEntry[];
  operation: null | {
    id: string;
    status: string;
    startedAt: number;
    runningTools: Array<{ toolName: string; status: string }>;
  };
  faulted: boolean;
}

export interface TranscriptEntry {
  id: string;
  type: string;
  timestamp: number;
  message?: {
    role: string;
    content: unknown;
    toolCallId?: string;
    toolName?: string;
  };
}

const embedded = window.piBio;
const base = embedded?.apiBase ?? import.meta.env.VITE_API_BASE ?? "";
const token = embedded?.token ?? localStorage.getItem("pi-bio-token") ?? "";

export async function runtimeStatus(): Promise<RuntimeStatus> {
  return request("/api/runtime");
}

export async function listSessions(): Promise<SessionSummary[]> {
  const result = await request<{ sessions: SessionSummary[] }>("/api/sessions");
  return result.sessions;
}

export async function createSession(name?: string): Promise<SessionSummary> {
  return request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
}

export async function getSnapshot(id: string): Promise<LaneSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function sendPrompt(id: string, text: string): Promise<PromptAccepted> {
  return request(`/api/sessions/${encodeURIComponent(id)}/prompts`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function abortPrompt(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
}

export async function streamEvents(
  id: string,
  after: number,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${base}/api/sessions/${encodeURIComponent(id)}/events?after=${after}`,
    { headers: headers(), signal },
  );
  if (!response.ok || response.body === null) throw await responseError(response);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventName = field(frame, "event");
      const data = field(frame, "data");
      if (eventName === "harness" && data !== undefined) onEvent(JSON.parse(data) as AgentEvent);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw await responseError(response);
  return (await response.json()) as T;
}

function headers(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token.length === 0 ? {} : { Authorization: `Bearer ${token}` }),
  };
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string };
    return new Error(body.error ?? `${response.status} ${response.statusText}`);
  } catch {
    return new Error(`${response.status} ${response.statusText}`);
  }
}

function field(frame: string, name: string): string | undefined {
  return frame
    .split("\n")
    .find((line) => line.startsWith(`${name}:`))
    ?.slice(name.length + 1)
    .trimStart();
}
