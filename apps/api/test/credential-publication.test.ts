import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { PiFileCredentialStore } from "../src/credential-store.js";

vi.mock("proper-lockfile", () => ({ default: { lock: vi.fn() } }));
vi.mock("write-file-atomic", () => ({ default: vi.fn() }));
const directories: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it("does not publish prepared credentials after observed lock loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bio-auth-publication-"));
  directories.push(directory);
  const path = join(directory, "auth.json");
  const previous = '{"provider":{"type":"api_key","key":"previous"}}\n';
  await writeFile(path, previous);
  let compromised: ((error: Error) => void) | undefined;
  vi.mocked(lockfile.lock).mockImplementation(async (_path, options) => {
    compromised = options?.onCompromised;
    return async () => undefined;
  });
  vi.mocked(writeFileAtomic).mockImplementation(async (pending, data) => {
    await writeFile(pending, String(data));
    compromised?.(new Error("Credential lock lost"));
  });
  const store = new PiFileCredentialStore(path);
  await expect(store.modify("provider", async () => ({ type: "api_key", key: "replacement" }))).rejects.toThrow("Credential lock lost");
  expect(await readFile(path, "utf8")).toBe(previous);
});

it("does not include malformed credential contents in parse errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bio-auth-malformed-"));
  directories.push(directory);
  const path = join(directory, "auth.json");
  await writeFile(path, 'secret-credential-not-json');
  vi.mocked(lockfile.lock).mockResolvedValue(async () => undefined);
  const store = new PiFileCredentialStore(path);
  await expect(store.read("provider")).rejects.toThrow("Invalid Pi auth.json: cannot parse credentials");
});
