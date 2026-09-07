import "./style.css";
import type { AgentEvent, RuntimeStatus, SessionSummary } from "@pi-bio/protocol";
import {
  abortPrompt,
  createSession,
  getSnapshot,
  listSessions,
  runtimeStatus,
  sendPrompt,
  streamEvents,
  type LaneSnapshot,
} from "./api.js";
import { renderRuntime, renderSessions, renderTranscript } from "./render.js";

const sessionsRoot = element("sessions");
const title = element("session-title");
const transcript = element("transcript");
const composer = element<HTMLFormElement>("composer");
const prompt = element<HTMLTextAreaElement>("prompt");
const abortButton = element<HTMLButtonElement>("abort");
const sendButton = element<HTMLButtonElement>("send");
const runState = element("run-state");
const runtimeRoot = element("runtime");
const operation = element("operation");
const toast = element("toast");

let sessions: SessionSummary[] = [];
let selectedId: string | undefined;
let snapshot: LaneSnapshot | undefined;
let streamController: AbortController | undefined;
let eventCursor = 0;
let refreshQueued = false;

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void runPrompt();
});
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
element("new-session").addEventListener("click", () => void newSession());
abortButton.addEventListener("click", () => void abortCurrent());

await initialize();
setInterval(() => void refreshRuntime(), 5_000);

async function initialize(): Promise<void> {
  try {
    await refreshRuntime();
    sessions = await listSessions();
    if (sessions.length === 0) sessions = [await createSession()];
    await selectSession(sessions[0]?.id);
  } catch (error) {
    showError(error);
  }
}

async function newSession(): Promise<void> {
  try {
    const session = await createSession();
    sessions = [session, ...sessions];
    await selectSession(session.id);
  } catch (error) {
    showError(error);
  }
}

async function selectSession(id: string | undefined): Promise<void> {
  if (id === undefined) return;
  streamController?.abort();
  selectedId = id;
  eventCursor = 0;
  renderSessions(sessionsRoot, sessions, selectedId, (next) => void selectSession(next));
  const selected = sessions.find((session) => session.id === id);
  title.textContent = selected?.name ?? id;
  await refreshSnapshot();
  streamController = new AbortController();
  void keepStreaming(id, streamController.signal);
}

async function keepStreaming(id: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await streamEvents(
        id,
        eventCursor,
        (record: AgentEvent) => {
          eventCursor = Math.max(eventCursor, record.sequence);
          queueSnapshotRefresh();
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted) return;
      showError(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function queueSnapshotRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    void refreshSnapshot();
  }, 80);
}

async function refreshSnapshot(): Promise<void> {
  if (selectedId === undefined) return;
  try {
    snapshot = await getSnapshot(selectedId);
    renderTranscript(transcript, snapshot);
    renderOperation(snapshot);
  } catch (error) {
    showError(error);
  }
}

async function refreshRuntime(): Promise<void> {
  try {
    const runtime: RuntimeStatus = await runtimeStatus();
    renderRuntime(runtimeRoot, runtime);
  } catch (error) {
    showError(error);
  }
}

async function runPrompt(): Promise<void> {
  const text = prompt.value.trim();
  if (selectedId === undefined || text.length === 0) return;
  prompt.value = "";
  sendButton.disabled = true;
  try {
    await sendPrompt(selectedId, text);
    await refreshSnapshot();
  } catch (error) {
    prompt.value = text;
    showError(error);
  } finally {
    sendButton.disabled = false;
    prompt.focus();
  }
}

async function abortCurrent(): Promise<void> {
  if (selectedId === undefined) return;
  try {
    await abortPrompt(selectedId);
  } catch (error) {
    showError(error);
  }
}

function renderOperation(value: LaneSnapshot): void {
  const activeOperation = value.operation;
  const active = activeOperation !== null;
  runState.className = `run-state ${active ? "running" : "idle"}`;
  runState.replaceChildren(document.createElement("span"), active ? "Running" : "Idle");
  abortButton.classList.toggle("hidden", !active);
  if (activeOperation === null) {
    operation.textContent = value.faulted ? "Harness faulted" : "No active operation";
    return;
  }
  operation.textContent = JSON.stringify(
    {
      id: activeOperation.id,
      status: activeOperation.status,
      tools: activeOperation.runningTools.map((tool) => tool.toolName),
    },
    null,
    2,
  );
}

function showError(error: unknown): void {
  toast.textContent = error instanceof Error ? error.message : String(error);
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 5_000);
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing #${id}`);
  return found as T;
}
