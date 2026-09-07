// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Drafts } from "../src/drafts.js";

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("draft persistence", () => {
  it("keeps immediate recovery text until a server save is acknowledged", async () => {
    const save = vi.fn(async () => undefined);
    const drafts = new Drafts(localStorage, save, vi.fn());
    drafts.change("one", "Unfinished question");
    expect(new Drafts(localStorage, save, vi.fn()).restore("one", "older server draft")).toBe("Unfinished question");
    expect(await drafts.flush("one")).toBe(true);
    expect(save).toHaveBeenCalledWith("one", "Unfinished question");
    expect(localStorage.getItem("pi-bio.draft.one")).toBeNull();
  });

  it("serializes saves without removing newer recovery text", async () => {
    let finish: (() => void) | undefined;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const drafts = new Drafts(localStorage, save, vi.fn());
    drafts.change("one", "first");
    const first = drafts.flush("one");
    await Promise.resolve();
    drafts.change("one", "second");
    const second = drafts.flush("one");
    finish?.();
    await first;
    expect(drafts.restore("one", "")).toBe("second");
    await second;
    expect(save.mock.calls).toEqual([["one", "first"], ["one", "second"]]);
    expect(localStorage.getItem("pi-bio.draft.one")).toBeNull();
  });

  it("retains an offline draft and reports the failed server save", async () => {
    const status = vi.fn();
    const drafts = new Drafts(localStorage, vi.fn().mockRejectedValue(new Error("offline")), status);
    drafts.change("one", "Still here");
    expect(await drafts.flush("one")).toBe(false);
    expect(drafts.restore("one", "")).toBe("Still here");
    expect(status).toHaveBeenLastCalledWith("one", "Draft kept on this device. Server save failed.");
  });
});
