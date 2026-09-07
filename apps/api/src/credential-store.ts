import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

type CredentialFile = Record<string, Credential>;

export class PiFileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(path = piAuthPath()) {
    this.path = resolve(path);
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.#withLock(async (credentials) => clone(credentials[providerId]), options);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#withLock(
      async (credentials) =>
        Object.entries(credentials).map(([providerId, credential]) => ({
          providerId,
          type: credential.type,
        })),
      options,
    );
  }

  async modify(
    providerId: string,
    change: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#withLock(async (credentials, assertLock) => {
      const current = clone(credentials[providerId]);
      const next = await change(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      assertLock();
      credentials[providerId] = clone(next) as Credential;
      await this.#write(credentials, assertLock);
      return clone(next);
    }, options);
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#withLock(async (credentials, assertLock) => {
      if (!(providerId in credentials)) return;
      assertLock();
      delete credentials[providerId];
      await this.#write(credentials, assertLock);
    }, options);
  }

  async #withLock<T>(
    action: (credentials: CredentialFile, assertLock: () => void) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    options?.signal?.throwIfAborted();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.path, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let compromised: Error | undefined;
    const assertLock = (): void => {
      if (compromised !== undefined) throw compromised;
    };
    const release = await this.#acquireLock(options?.signal, (error) => {
      compromised = error;
    });
    try {
      assertLock();
      options?.signal?.throwIfAborted();
      const credentials = await this.#read();
      const result = await action(credentials, assertLock);
      assertLock();
      options?.signal?.throwIfAborted();
      return result;
    } finally {
      if (compromised !== undefined) await release().catch(() => undefined);
      else await release();
    }
  }

  async #acquireLock(
    signal: AbortSignal | undefined,
    onCompromised: (error: Error) => void,
  ): Promise<() => Promise<void>> {
    const deadline = Date.now() + 30_000;
    let retry = 0;
    while (true) {
      signal?.throwIfAborted();
      try {
        const release = await lockfile.lock(this.path, {
          realpath: false,
          stale: 30_000,
          update: 5_000,
          retries: 0,
          onCompromised,
        });
        if (signal?.aborted) {
          await release();
          signal.throwIfAborted();
        }
        return release;
      } catch (error) {
        signal?.throwIfAborted();
        const code = (error as NodeJS.ErrnoException).code;
        const remaining = deadline - Date.now();
        if (code !== "ELOCKED" || remaining <= 0) throw error;
        const maximum = Math.min(20 * 2 ** retry, 1_000, remaining);
        retry += 1;
        const delay = Math.max(1, Math.round(maximum * (0.5 + Math.random() / 2)));
        if (signal !== undefined) await sleep(delay, undefined, { signal });
        else await sleep(delay);
      }
    }
  }

  async #read(): Promise<CredentialFile> {
    const source = (await readFile(this.path, "utf8")).replace(/^\uFEFF/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(source); }
    catch { throw new Error("Invalid Pi auth.json: cannot parse credentials"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid Pi auth.json: expected an object");
    }
    for (const [providerId, credential] of Object.entries(parsed)) {
      if (!isCredential(credential)) {
        throw new Error(`Invalid Pi auth.json credential for provider ${providerId}`);
      }
    }
    return parsed as CredentialFile;
  }

  async #write(credentials: CredentialFile, assertLock: () => void): Promise<void> {
    const pending = `${this.path}.${randomUUID()}.pending`;
    try {
      await writeFileAtomic(pending, `${JSON.stringify(credentials, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600, fsync: true,
      });
      // Publish only if the lease survived preparation; do not yield between this check and rename.
      assertLock();
      renameSync(pending, this.path);
    } finally {
      await rm(pending, { force: true });
    }
  }
}

export function piAuthPath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  let directory = configured && configured.length > 0 ? configured : join(homedir(), ".pi", "agent");
  if (directory === "~") directory = homedir();
  if (directory.startsWith("~/") || directory.startsWith("~\\")) {
    directory = join(homedir(), directory.slice(2));
  }
  return join(directory, "auth.json");
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "api_key") {
    const env = candidate.env;
    return (
      (candidate.key === undefined || typeof candidate.key === "string") &&
      (env === undefined ||
        (typeof env === "object" &&
          env !== null &&
          !Array.isArray(env) &&
          Object.values(env).every((entry) => typeof entry === "string")))
    );
  }
  return (
    candidate.type === "oauth" &&
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  );
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
