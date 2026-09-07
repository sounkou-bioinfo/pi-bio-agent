import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import App from "../src/App.svelte";
import * as api from "../src/api.js";

vi.mock("../src/api.js", () => ({
  providers: vi.fn(), listSessions: vi.fn(), getSnapshot: vi.fn(), authStatus: vi.fn(), sendPrompt: vi.fn(),
  saveDraft: vi.fn(), renameSession: vi.fn(), archiveSession: vi.fn(), restoreSession: vi.fn(),
  sessionTree: vi.fn(), selectModel: vi.fn(), selectThinking: vi.fn(), streamEvents: vi.fn(),
}));

const streams = new Map<string, Parameters<typeof api.streamEvents>[1]>();

function emptySnapshot(): api.LaneSnapshot {
  return {
    lane: "main", tipId: null,
    draft: "", eventCursor: 0,
    configuration: { model: { provider: "provider", modelId: "model" }, thinkingLevel: "off", activeToolNames: [] },
    transcript: [], operation: null, faulted: false, queues: [],
    stats: { messageCount: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  };
}

beforeEach(() => {
  localStorage.clear();
  streams.clear();
  vi.mocked(api.providers).mockResolvedValue([{ id: "provider", name: "Research provider", methods: [], models: [{ id: "model", name: "Research model", thinkingLevels: ["off"] }] }]);
  vi.mocked(api.listSessions).mockImplementation(async (archived) => archived ? [{ id: "archived", name: "Archived analysis", createdAt: 0, modifiedAt: 0, archivedAt: 1 }] : [{ id: "one", name: "My analysis", createdAt: 0, modifiedAt: 0 }]);
  vi.mocked(api.getSnapshot).mockImplementation(async () => emptySnapshot());
  vi.mocked(api.authStatus).mockResolvedValue({ providerId: "provider", status: "connected", authType: "oauth" });
  vi.mocked(api.sessionTree).mockResolvedValue({ entries: [], lanes: [] });
  vi.mocked(api.saveDraft).mockResolvedValue();
  vi.mocked(api.streamEvents).mockImplementation(async (id, event, signal) => {
    streams.set(id, event);
    event({ sessionId: id, sequence: 0, event: { type: "snapshot", snapshot: emptySnapshot() } });
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("workspace interactions", () => {
  it("supports a keyboard command picker with Pi's names", async () => {
    const view = render(App);
    const input = view.getByRole("textbox", { name: "Message Pi Bio" });
    await waitFor(() => expect((input as HTMLTextAreaElement).readOnly).toBe(false));
    await fireEvent.input(input, { target: { value: "/" } });
    expect(view.getByRole("listbox", { name: "Slash commands" })).toBeDefined();
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(view.getByRole("listbox", { name: "Slash commands" })).getByRole("option", { selected: true }).textContent).toContain("/name");
    await fireEvent.keyDown(input, { key: "Tab" });
    expect((input as HTMLTextAreaElement).value).toBe("/name ");
    await fireEvent.input(input, { target: { value: "/name Renamed" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.renameSession).toHaveBeenCalledWith("one", "Renamed"));
    expect(view.container.textContent).not.toContain("Harness");
  });

  it("renders Pi events without fetching snapshots on every update and ignores an old stream", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: "one", name: "My analysis", createdAt: 0, modifiedAt: 0 },
      { id: "two", name: "Other analysis", createdAt: 0, modifiedAt: 0 },
    ]);
    const view = render(App);
    await waitFor(() => expect(streams.has("one")).toBe(true));
    const emit = streams.get("one")!;
    emit({ sessionId: "one", sequence: 1, event: { type: "run_start", lane: "main", runId: "run", startedAt: 1 } });
    const message = fauxAssistantMessage("A streamed result", { stopReason: "pending" });
    emit({ sessionId: "one", sequence: 2, event: { type: "message_start", lane: "main", runId: "run", message } });
    await waitFor(() => expect(view.container.textContent).toContain("A streamed result"));
    expect(api.getSnapshot).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole("button", { name: /Other analysis/ }));
    await waitFor(() => expect(streams.has("two")).toBe(true));
    emit({ sessionId: "one", sequence: 3, event: { type: "run_start", lane: "main", runId: "old", startedAt: 2 } });
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.container.textContent).not.toContain("A streamed result");
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does not replace newer streamed state with a late refresh response", async () => {
    let resolveRefresh: ((snapshot: api.LaneSnapshot) => void) | undefined;
    vi.mocked(api.getSnapshot).mockResolvedValueOnce(emptySnapshot())
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const view = render(App);
    await waitFor(() => expect(streams.has("one")).toBe(true));
    await fireEvent.change(view.getByRole("combobox", { name: "Thinking level" }), { target: { value: "off" } });
    await waitFor(() => expect(resolveRefresh).toBeDefined());
    const emit = streams.get("one")!;
    emit({ sessionId: "one", sequence: 1, event: { type: "run_start", lane: "main", runId: "run", startedAt: 1 } });
    emit({ sessionId: "one", sequence: 2, event: { type: "message_start", lane: "main", runId: "run", message: fauxAssistantMessage("Newer result", { stopReason: "pending" }) } });
    await waitFor(() => expect(view.container.textContent).toContain("Newer result"));
    resolveRefresh?.(emptySnapshot());
    await waitFor(() => expect((view.getByRole("button", { name: /New analysis/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(view.container.textContent).toContain("Newer result");
  });

  it("ignores an old snapshot when switching A to B and back to A", async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: "one", name: "My analysis", createdAt: 0, modifiedAt: 0 },
      { id: "two", name: "Other analysis", createdAt: 0, modifiedAt: 0 },
    ]);
    let resolveOld: ((snapshot: api.LaneSnapshot) => void) | undefined;
    vi.mocked(api.getSnapshot)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(emptySnapshot())
      .mockResolvedValueOnce({ ...emptySnapshot(), draft: "Latest draft" });
    const view = render(App);
    await waitFor(() => expect(resolveOld).toBeDefined());
    await fireEvent.click(view.getByRole("button", { name: /Other analysis/ }));
    await waitFor(() => expect(streams.has("two")).toBe(true));
    await fireEvent.click(view.getByRole("button", { name: /My analysis/ }));
    const input = view.getByRole("textbox", { name: "Message Pi Bio" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe("Latest draft"));
    resolveOld?.({ ...emptySnapshot(), draft: "Stale draft" });
    await waitFor(() => expect((view.getByRole("button", { name: /New analysis/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(input.value).toBe("Latest draft");
  });

  it("blocks prompts and selection while archive admission is pending", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(api.archiveSession).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(App);
    const input = view.getByRole("textbox", { name: "Message Pi Bio" }) as HTMLTextAreaElement;
    await waitFor(() => expect(input.readOnly).toBe(false));
    await fireEvent.input(input, { target: { value: "Keep this draft" } });
    await fireEvent.click(view.getByRole("button", { name: "Session" }));
    await fireEvent.click(view.getByRole("button", { name: "Archive session" }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(input.readOnly).toBe(true);
    expect((view.getByRole("button", { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: /My analysis/ }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(api.sendPrompt).not.toHaveBeenCalled();
    finish?.();
    await waitFor(() => expect((view.getByRole("button", { name: "Archived" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("exposes archive and restore without deleting scientific data", async () => {
    const view = render(App);
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("My analysis"));
    await fireEvent.click(view.getByRole("button", { name: "Session" }));
    await fireEvent.click(view.getByRole("button", { name: "Archive session" }));
    await waitFor(() => expect(api.archiveSession).toHaveBeenCalledWith("one"));
    await waitFor(() => expect((view.getByRole("button", { name: "Archived" }) as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(view.getByRole("button", { name: "Archived" }));
    await waitFor(() => expect(view.getByRole("heading", { level: 1 }).textContent).toBe("Archived analysis"));
    expect((view.getByRole("textbox", { name: "Message Pi Bio" }) as HTMLTextAreaElement).readOnly).toBe(true);
    await fireEvent.click(view.getByRole("button", { name: "Restore to continue" }));
    await waitFor(() => expect(api.restoreSession).toHaveBeenCalledWith("archived"));
  });
});
