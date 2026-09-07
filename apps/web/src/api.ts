import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AuthStatus,
  AuthReply,
  LoginRequest,
  ModelSelection,
  ProviderSummary,
  PromptAccepted,
  SessionSummary,
  SessionTree,
  WorkspaceSnapshot,
} from "@pi-bio/protocol";

declare global {
  interface Window {
    piBio?: { apiBase: string; token: string };
  }
}

export type LaneSnapshot = WorkspaceSnapshot;
export type ChatMessage = AgentMessage;

const embedded = window.piBio;
const base = embedded?.apiBase ?? import.meta.env.VITE_API_BASE ?? "";
const token = embedded?.token ?? localStorage.getItem("pi-bio-token") ?? "";

export async function providers(): Promise<ProviderSummary[]> {
  return request("/api/providers");
}

export async function authStatus(provider: string): Promise<AuthStatus> {
  return request(`/api/providers/${encodeURIComponent(provider)}/auth`);
}

export async function login(provider: string, value: LoginRequest): Promise<AuthStatus> {
  return request(`/api/providers/${encodeURIComponent(provider)}/auth/login`, { method: "POST", body: JSON.stringify(value) });
}

export async function answerLogin(provider: string, value: AuthReply): Promise<AuthStatus> {
  return request(`/api/providers/${encodeURIComponent(provider)}/auth/reply`, { method: "POST", body: JSON.stringify(value) });
}

export async function cancelLogin(provider: string): Promise<AuthStatus> {
  return request(`/api/providers/${encodeURIComponent(provider)}/auth/login`, { method: "DELETE" });
}

export async function logout(provider: string): Promise<AuthStatus> {
  return request(`/api/providers/${encodeURIComponent(provider)}/auth`, { method: "DELETE" });
}

export async function selectThinking(id: string, level: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/thinking`, { method: "PUT", body: JSON.stringify({ level }) });
}

export async function selectModel(id: string, selection: ModelSelection): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/model`, { method: "PUT", body: JSON.stringify(selection) });
}

export async function listSessions(archived = false): Promise<SessionSummary[]> {
  const result = await request<{ sessions: SessionSummary[] }>(`/api/sessions${archived ? "?archived=true" : ""}`);
  return result.sessions;
}

export async function createSession(name?: string): Promise<SessionSummary> {
  return request("/api/sessions", {
    method: "POST",
    body: JSON.stringify(name === undefined ? {} : { name }),
  });
}

export async function archiveSession(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function restoreSession(id: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export async function renameSession(id: string, name: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function forkSession(id: string, entryId?: string): Promise<SessionSummary> {
  return request(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", body: JSON.stringify({ entryId }) });
}

export async function sessionTree(id: string, cursor?: number): Promise<SessionTree> {
  return request(`/api/sessions/${encodeURIComponent(id)}/tree${cursor === undefined ? "" : `?cursor=${cursor}`}`);
}

export async function getSnapshot(id: string, signal?: AbortSignal): Promise<LaneSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

export async function saveDraft(id: string, text: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/draft`, {
    method: "PUT", body: JSON.stringify({ text }),
  });
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
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${base}/api/sessions/${encodeURIComponent(id)}/events`,
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
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("The API returned a web page instead of data. Restart the API and frontend together.");
  }
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
