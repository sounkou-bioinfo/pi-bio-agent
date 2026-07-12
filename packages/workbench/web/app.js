import { mountWorkbenchAddons } from "/addon-runtime.js";

const state = {
  info: null,
  sessions: [],
  active: null,
  transcript: [],
  events: [],
  commands: [],
  eventSource: null,
  liveText: "",
};

const WORKBENCH_COMMANDS = [
  { name: "rename", description: "Rename this session", source: "workbench" },
  { name: "new", description: "Start a new session", source: "workbench" },
  { name: "close", description: "Close this session", source: "workbench" },
  { name: "abort", description: "Stop the running turn", source: "workbench" },
];

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
const renameButton = element("rename-session");
const renameForm = element("rename-form");
const sessionNameInput = element("session-name");
const commandMenu = element("command-menu");
const diagnostics = element("diagnostics");

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

function toolResult(message) {
  const details = node("details", `tool-detail${message.errorMessage ? " tool-error" : ""}`);
  const label = message.errorMessage ? "Failed" : "Finished";
  details.append(node("summary", null, `${label} ${message.toolName || "tool"}`));
  const text = messageText(message);
  if (text) details.append(node("pre", "tool-payload", text));
  if (message.errorMessage) details.append(node("div", "message-error", message.errorMessage));
  return details;
}

function renderTranscript() {
  transcript.replaceChildren();
  element("empty-agent").hidden = Boolean(state.active);
  if (!state.active) return;
  for (const message of state.transcript) {
    const role = message.role ?? "event";
    if (role === "toolResult") {
      transcript.append(toolResult(message));
      continue;
    }
    const row = node("article", `message message-${role}`);
    row.append(node("div", "message-role", role === "toolResult" ? message.toolName || "tool" : role));
    const text = messageText(message);
    if (text) row.append(node("pre", "message-text", text));
    for (const call of toolBlocks(message)) {
      const callRow = node("details", "tool-detail");
      callRow.append(node("summary", null, `Called ${call.name || "tool"}`));
      callRow.append(node("pre", "tool-payload", JSON.stringify(call.arguments ?? {}, null, 2)));
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
  if (event.kind === "session_renamed") return `Renamed to ${payload.name ?? "session"}`;
  if (event.kind === "compaction_start") return "Compacting context";
  if (event.kind === "compaction_end") return payload.aborted ? "Compaction stopped" : "Context compacted";
  if (event.kind === "auto_retry_start") return `Retrying request · attempt ${payload.attempt ?? ""}`;
  return event.kind.replaceAll("_", " ");
}

function isMeaningfulActivity(event) {
  return [
    "session_opened", "session_renamed", "agent_start", "agent_end", "tool_execution_start",
    "tool_execution_end", "queue_update", "host_error", "compaction_start", "compaction_end",
    "auto_retry_start", "auto_retry_end",
  ].includes(event.kind);
}

function renderActivity() {
  activityList.replaceChildren();
  const events = state.events.filter(isMeaningfulActivity).slice(-30).reverse();
  element("activity-count").textContent = events.length ? String(events.length) : "";
  if (!events.length && state.active) activityList.append(node("p", "muted activity-empty", "No active work"));
  for (const event of events) {
    const details = node("details", `activity-event activity-${event.kind}`);
    const summary = node("summary");
    summary.append(node("span", "activity-label", activityLabel(event)), node("time", null, timeLabel(event.at)));
    const data = node("pre", "event-json", JSON.stringify(event.payload, null, 2));
    details.append(summary, data);
    activityList.append(details);
  }
  renderDiagnostics();
}

function renderDiagnostics() {
  element("diagnostic-count").textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"}`;
  if (!diagnostics.open) return;
  const list = element("diagnostic-list");
  list.replaceChildren();
  const groups = [];
  for (const event of state.events.slice(-120)) {
    const previous = groups.at(-1);
    if (previous?.kind === event.kind) {
      previous.count += 1;
      previous.event = event;
    } else groups.push({ kind: event.kind, count: 1, event });
  }
  for (const group of groups.reverse()) {
    const details = node("details", "diagnostic-event");
    const suffix = group.count > 1 ? ` × ${group.count}` : "";
    details.append(
      node("summary", null, `${activityLabel(group.event)}${suffix}`),
      node("pre", "event-json", JSON.stringify(group.event.payload, null, 2)),
    );
    list.append(details);
  }
}

function setControls() {
  const enabled = Boolean(state.active);
  messageInput.disabled = !enabled;
  delivery.disabled = !enabled;
  sendButton.disabled = !enabled;
  abortButton.disabled = !enabled || state.active?.state !== "running";
  closeButton.disabled = !enabled;
  renameButton.disabled = !enabled;
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

async function loadCommands() {
  state.commands = [];
  if (!state.active || !state.info?.capabilities.agentCommands) return;
  const result = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/commands`);
  state.commands = result.commands;
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
  if (isMeaningfulActivity(event)) renderActivity();
  else renderDiagnostics();
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
    await loadCommands();
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

function openRename() {
  if (!state.active) return;
  sessionNameInput.value = state.active.name || "";
  renameForm.hidden = false;
  sessionNameInput.focus();
  sessionNameInput.select();
}

function closeRename() {
  renameForm.hidden = true;
}

async function renameSession(name) {
  if (!state.active) return;
  state.active = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  closeRename();
  await refreshSessions();
}

function allCommands() {
  const seen = new Set();
  const hostCommands = state.active?.state === "idle" ? state.commands : [];
  return [...WORKBENCH_COMMANDS, ...hostCommands].filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

function closeCommandMenu() {
  commandMenu.hidden = true;
  commandMenu.replaceChildren();
  messageInput.setAttribute("aria-expanded", "false");
}

function renderCommandMenu() {
  const value = messageInput.value;
  if (!value.startsWith("/") || value.includes("\n")) {
    closeCommandMenu();
    return;
  }
  const query = value.slice(1).split(/\s/, 1)[0].toLowerCase();
  const commands = allCommands().filter((command) => command.name.toLowerCase().includes(query)).slice(0, 12);
  commandMenu.replaceChildren();
  if (!commands.length) {
    closeCommandMenu();
    return;
  }
  for (const command of commands) {
    const button = node("button", "command-option");
    button.type = "button";
    button.setAttribute("role", "option");
    button.append(
      node("code", null, `/${command.name}`),
      node("span", null, command.description || command.source),
      node("small", null, command.source),
    );
    button.addEventListener("click", () => {
      messageInput.value = `/${command.name} `;
      closeCommandMenu();
      messageInput.focus();
    });
    commandMenu.append(button);
  }
  commandMenu.hidden = false;
  messageInput.setAttribute("aria-expanded", "true");
}

async function executeWorkbenchCommand(text) {
  const match = /^\/(rename|new|close|abort)(?:\s+(.*))?$/.exec(text);
  if (!match) return false;
  const [, command, rawArgs = ""] = match;
  const args = rawArgs.trim();
  if (command === "rename") {
    if (!args) openRename();
    else await renameSession(args);
  } else if (command === "new") element("new-session").click();
  else if (command === "close") closeButton.click();
  else if (command === "abort") abortButton.click();
  return true;
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
    state.commands = [];
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
    const text = messageInput.value.trim();
    if (await executeWorkbenchCommand(text)) {
      messageInput.value = "";
      closeCommandMenu();
      return;
    }
    state.active = await request(`/v1/agent-sessions/${encodeURIComponent(state.active.sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ delivery: delivery.value, text }),
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

renameButton.addEventListener("click", openRename);
element("cancel-rename").addEventListener("click", closeRename);
renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await renameSession(sessionNameInput.value.trim());
  } catch (error) {
    showError(error);
  }
});

messageInput.addEventListener("input", renderCommandMenu);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeCommandMenu();
});
diagnostics.addEventListener("toggle", renderDiagnostics);

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
