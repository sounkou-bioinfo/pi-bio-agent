import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthStatus } from "@pi-bio/protocol";
import Account from "../src/Account.svelte";
import * as api from "../src/api.js";

vi.mock("../src/api.js", () => ({ authStatus: vi.fn(), logout: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.resetAllMocks(); });

it("does not let a stale auth poll reconnect the UI after sign-out", async () => {
  vi.useFakeTimers();
  const connected: AuthStatus = { providerId: "provider", status: "connected" };
  const disconnected: AuthStatus = { providerId: "provider", status: "disconnected" };
  let resolveOld: ((value: AuthStatus) => void) | undefined;
  vi.mocked(api.authStatus)
    .mockResolvedValueOnce(connected)
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValue(disconnected);
  vi.mocked(api.logout).mockResolvedValue(disconnected);
  const onstatus = vi.fn();
  const view = render(Account, { provider: { id: "provider", name: "Provider", models: [], methods: [] }, onstatus });
  await vi.waitFor(() => expect(onstatus).toHaveBeenCalledWith(connected));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(resolveOld).toBeDefined();
  const details = view.container.querySelector("details")!;
  details.open = true;
  await tick();
  await fireEvent.click(view.getByRole("button", { name: "Sign out" }));
  await vi.waitFor(() => expect(onstatus).toHaveBeenLastCalledWith(disconnected));
  resolveOld?.(connected);
  await Promise.resolve();
  await tick();
  expect(onstatus).toHaveBeenLastCalledWith(disconnected);
  expect(view.container.querySelector(".account-dot.connected")).toBeNull();
});

it("preserves an answer during polling and clears it when the prompt changes", async () => {
  vi.useFakeTimers();
  const first: AuthStatus = { providerId: "provider", status: "connecting", prompt: { id: "first", type: "secret", message: "API key" } };
  vi.mocked(api.authStatus).mockResolvedValue(first);
  const view = render(Account, { provider: { id: "provider", name: "Provider", models: [], methods: [] }, onstatus: vi.fn() });
  await vi.waitFor(() => expect(view.queryByLabelText("API key")).not.toBeNull());
  const key = view.getByLabelText("API key") as HTMLInputElement;
  await fireEvent.input(key, { target: { value: "private-answer" } });
  vi.mocked(api.authStatus).mockResolvedValue({ ...first });
  await vi.advanceTimersByTimeAsync(700);
  expect(key.value).toBe("private-answer");
  vi.mocked(api.authStatus).mockResolvedValue({ ...first, prompt: { id: "second", type: "text", message: "Verification code" } });
  await vi.advanceTimersByTimeAsync(700);
  expect((view.getByLabelText("Verification code") as HTMLInputElement).value).toBe("");
});
