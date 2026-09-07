import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { PiFileCredentialStore } from "../src/credential-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PiFileCredentialStore", () => {
  it("uses Pi's CredentialStore contract without losing other providers", async () => {
    const path = await authPath();
    const store = new PiFileCredentialStore(path);
    const codex: Credential = {
      type: "oauth",
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60_000,
      accountId: "account",
    };
    await store.modify("openai-codex", async () => codex);
    await store.modify("another-provider", async () => ({ type: "api_key", key: "other" }));

    expect(await store.read("openai-codex")).toEqual(codex);
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { providerId: "openai-codex", type: "oauth" },
        { providerId: "another-provider", type: "api_key" },
      ]),
    );
    const disk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(disk)).toEqual(expect.arrayContaining(["openai-codex", "another-provider"]));
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("serializes concurrent credential modifications", async () => {
    const path = await authPath();
    const first = new PiFileCredentialStore(path);
    const second = new PiFileCredentialStore(path);
    await Promise.all([
      first.modify("one", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: "api_key", key: "1" };
      }),
      second.modify("two", async () => ({ type: "api_key", key: "2" })),
    ]);
    expect(await first.list()).toHaveLength(2);
  });
});

async function authPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-bio-auth-"));
  directories.push(directory);
  return join(directory, "auth.json");
}
