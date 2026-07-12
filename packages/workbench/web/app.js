import { mountWorkbenchAddons } from "/addon-runtime.js";

const state = {
  info: null,
  sessions: [],
  active: null,
  transcript: [],
  events: [],
  eventSource: null,
  liveText: "",
};

const sessionListeners = new Set();
let viewController = null;

const element = (id) => document.getElementById(id);
const sessionList = element("session-list");
const transcript = element("transcript");
const activityList = element("activity-list");
const sessionFacts = element("session-facts");
const messageInput = element("message");
const delivery = element("delivery");
const sendButton = element("send");
const abortButton = element("abort");
const closeButton = element("close-session");

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
  return body;
}

function node(tag, className, text) {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text !== undefined) out.textContent = text;
  return out;
}

function shortId(value) {
  if (!value) return "";
  return value.length > 20 ? `${value.slice(0, 9)}...${value.slice(-7)}` : value;
}

function timeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function renderSessions() {
  sessionList.replaceChildren();
  if (state.sessions.length === 0) {
    sessionList.append(node("p", "muted", "No sessions"));
    return;
  }
  for (const session of state.sessions) {
    const button = node("button", `session-row${state.active?.sessionId === session.sessionId ? " selected" : ""}`);
    button.type = "button";
    const name = node("span", "session-name", session.name || `Session ${shortId(session.sessionId)}`);
    const meta = node("span", "session-meta", `${session.state} · ${session.messageCount} messages`);
    button.append(name, meta);
    button.addEventListener("click", () => void selectSession(session));
    sessionList.append(button);
  }
}

function renderSessionFacts() {
  sessionFacts.replaceChildren();
  if (!state.active) return;
  const facts = [
    ["State", state.active.state],
    ["Model", state.active.model ? `${state.active.model.provider}/${state.active.model.id}` : "Unselected"],
    ["Thinking", state.active.thinkingLevel ?? "Default"],
    ["Messages", String(state.active.messageCount)],
    ["Session", shortId(state.active.sessionId)],
  ];
  for (const [label, value] of facts) {
    sessionFacts.append(node("dt", null, label), node("dd", null, value));
  }
}

function toolBlocks(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter((block) => block?.type === "toolCall");
}

function renderTranscript() {
  transcript.replaceChildren();
  element("empty-agent").hidden = Boolean(state.active);
  if (!state.active) return;
  for (const message of state.transcript) {
    const role = message.role ?? "event";
    const row = node("article", `message message-${role}`);
    row.append(node("div", "message-role", role === "toolResult" ? message.toolName || "tool" : role));
    const text = messageText(message);
    if (text) row.append(node("pre", "message-text", text));
    for (const call of toolBlocks(message)) {
      const callRow = node("div", "tool-call");
      callRow.append(node("span", "tool-name", call.name || "tool"));
      callRow.append(node("code", null, JSON.stringify(call.arguments ?? {})));
      row.append(callRow);
    }
    if (message.errorMessage) row.append(node("div", "message-error", message.errorMessage));
    transcript.append(row);
  }
  if (state.liveText) {
    const live = node("article", "message message-assistant live");
    live.append(node("div", "message-role", "assistant"), node("pre", "message-text", state.liveText));
    transcript.append(live);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function activityLabel(event) {
  const payload = event.payload ?? {};
  if (event.kind === "tool_execution_start") return `Started ${payload.toolName ?? "tool"}`;
  if (event.kind === "tool_execution_end") return `${payload.isError ? "Failed" : "Finished"} ${payload.toolName ?? "tool"}`;
  if (event.kind === "queue_update") return `Queue: ${payload.steeringCount ?? 0} steer, ${payload.followUpCount ?? 0} follow-up`;
  if (event.kind === "agent_start") return "Agent started";
  if (event.kind === "agent_end") return "Agent settled";
  if (event.kind === "host_error") return "Host error";
  if (event.kind === "session_opened") return payload.resumed ? "Session resumed" : "Session opened";
  return event.kind.replaceAll("_", " ");
}

function renderActivity() {
  activityList.replaceChildren();
  for (const event of state.events.slice(-60).reverse()) {
    const details = node("details", `activity-event activity-${event.kind}`);
    const summary = node("summary");
    summary.append(node("span", "activity-label", activityLabel(event)), node("time", null, timeLabel(event.at)));
    const data = node("pre", "event-json", JSON.stringify(event.payload, null, 2));
    details.append(summary, data);
    activityList.append(details);
  }
}

function setControls() {
  const enabled = Boolean(state.active);
  messageInput.disabled = !enabled;
  delivery.disabled = !enabled;
  sendButton.disabled = !enabled;
  abortButton.disabled = !enabled || state.active?.state !== "running";
  closeButton.disabled = !enabled;
  if (state.active?.state === "running" && delivery.value === "prompt") delivery.value = "steer";
  if (state.active?.state !== "running" && delivery.value === "steer") delivery.value = "prompt";
}

function notifySessionChange() {
  for (const listener of sessionListeners) listener(state.active);
}

async function refreshSessions() {
  if (!state.info?.capabilities.agentSessions) return;
  const result = await request("/v1/agent-sessions");
  state.sessions = result.sessions;
  if (state.active) state.active = state.sessions.find((item) => item.sessionId === state.active.sessionId) ?? state.active;
  renderSessions();
  renderSessionFacts();
  setControls();
  notifySessionChange();
}

async function loadTranscript() {
  if (!state.active) return;
  const page = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/transcript?limit=150`);
  state.transcript = page.messages;
  state.liveText = "";
  renderTranscript();
}

function handleActivity(event) {
  state.events.push(event);
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
  if (event.kind === "message_update" && event.payload?.assistantMessageEvent?.type === "text_delta") {
    state.liveText += event.payload.assistantMessageEvent.delta ?? "";
    renderTranscript();
  }
  if (["message_end", "agent_end"].includes(event.kind)) void loadTranscript();
  if (["agent_start", "agent_end", "queue_update", "host_error"].includes(event.kind)) void refreshActive();
  renderActivity();
}

function connectEvents() {
  state.eventSource?.close();
  state.eventSource = null;
  state.events = [];
  renderActivity();
  if (!state.active) return;
  const source = new EventSource(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/event-stream`);
  source.addEventListener("activity", (raw) => {
    try { handleActivity(JSON.parse(raw.data)); } catch { /* malformed host event is ignored by the view */ }
  });
  source.addEventListener("error", () => {
    element("service-label").textContent = "Reconnecting";
    element("service-dot").classList.add("warning");
  });
  source.addEventListener("open", () => {
    element("service-label").textContent = state.info?.agentHost ? `Ready · ${state.info.agentHost}` : "Ready";
    element("service-dot").classList.remove("warning");
  });
  state.eventSource = source;
}

async function refreshActive() {
  if (!state.active) return;
  try {
    state.active = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}`);
    renderSessionFacts();
    setControls();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
}

async function selectSession(session) {
  try {
    state.active = session.state === "available"
      ? await request("/v1/agent-sessions", { method: "POST", body: JSON.stringify({ resumeSessionId: session.sessionId }) })
      : await request(`/v1/agent-sessions/${encodeURIComponent(session.sessionId)}`);
    state.transcript = [];
    renderSessions();
    renderSessionFacts();
    setControls();
    await loadTranscript();
    connectEvents();
    notifySessionChange();
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  const event = {
    cursor: Date.now(),
    at: new Date().toISOString(),
    kind: "host_error",
    payload: { message: error instanceof Error ? error.message : String(error) },
  };
  state.events.push(event);
  renderActivity();
}

element("new-session").addEventListener("click", async () => {
  try {
    const session = await request("/v1/agent-sessions", { method: "POST", body: "{}" });
    await refreshSessions();
    await selectSession(session);
    messageInput.focus();
  } catch (error) {
    showError(error);
  }
});

closeButton.addEventListener("click", async () => {
  if (!state.active) return;
  const sessionId = state.active.sessionId;
  try {
    await request(`/v1/agent-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    state.eventSource?.close();
    state.eventSource = null;
    state.active = null;
    state.transcript = [];
    state.events = [];
    state.liveText = "";
    renderTranscript();
    renderActivity();
    renderSessionFacts();
    setControls();
    notifySessionChange();
    await refreshSessions();
  } catch (error) {
    showError(error);
  }
});

element("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.active || !messageInput.value.trim()) return;
  sendButton.disabled = true;
  try {
    state.active = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ delivery: delivery.value, text: messageInput.value.trim() }),
    });
    messageInput.value = "";
    setControls();
    await refreshSessions();
  } catch (error) {
    showError(error);
  } finally {
    sendButton.disabled = false;
  }
});

abortButton.addEventListener("click", async () => {
  if (!state.active) return;
  try {
    state.active = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/abort`, { method: "POST", body: "{}" });
    await refreshActive();
  } catch (error) {
    showError(error);
  }
});

async function boot() {
  try {
    state.info = await request("/v1/workbench");
    element("service-label").textContent = state.info.agentHost ? `Ready · ${state.info.agentHost}` : "Agent unavailable";
    element("service-dot").classList.add(state.info.agentHost ? "ready" : "warning");
    element("new-session").disabled = !state.info.capabilities.agentSessions;
    const addonHost = {
      request,
      node,
      getActiveSession: () => state.active,
      onSessionChange(listener) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      setAgentDraft(text) {
        messageInput.value = text;
        viewController?.activate("agent");
        messageInput.focus();
      },
    };
    viewController = await mountWorkbenchAddons({
      descriptors: state.info.addons,
      tabs: element("view-tabs"),
      workspace: document.querySelector(".workspace"),
      agentView: element("agent-view"),
      host: addonHost,
    });
    await refreshSessions();
  } catch (error) {
    element("service-label").textContent = "Unavailable";
    element("service-dot").classList.add("warning");
    showError(error);
  }
}

void boot();
