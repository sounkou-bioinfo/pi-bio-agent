import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ScienceOperation,
  ScienceRequest,
  ScienceResponse,
  ScienceState,
  ScienceWorkerMessage,
} from "./protocol.js";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface ScienceRuntimeStatus extends ScienceState {
  worker: "stopped" | "starting" | "ready" | "failed";
}

export interface ScienceToolRuntime {
  status(): ScienceRuntimeStatus;
  sql(sql: string, maxRows?: number, signal?: AbortSignal): Promise<unknown>;
  evalR(scope: string, code: string, maxRows?: number, signal?: AbortSignal): Promise<unknown>;
  resetR(scope: string, signal?: AbortSignal): Promise<unknown>;
}

export interface ScienceRuntimeOptions {
  databasePath: string;
  workerUrl?: URL;
  startupTimeoutMs?: number;
}

export class ScienceRuntime {
  readonly #databasePath: string;
  readonly #workerUrl: URL;
  readonly #startupTimeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #workerStatus: ScienceRuntimeStatus["worker"] = "stopped";
  #state: ScienceState = { duckdb: "idle", r: "idle" };
  #stderr = "";

  constructor(options: ScienceRuntimeOptions) {
    this.#databasePath = options.databasePath;
    this.#workerUrl = options.workerUrl ?? new URL("./worker.js", import.meta.url);
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  }

  status(): ScienceRuntimeStatus {
    return { worker: this.#workerStatus, ...this.#state };
  }

  async sql(sql: string, maxRows = 100, signal?: AbortSignal): Promise<unknown> {
    return this.#request("sql", { sql, maxRows }, signal);
  }

  async evalR(
    scope: string,
    code: string,
    maxRows = 100,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#request("r_eval", { scope, code, maxRows }, signal);
  }

  async resetR(scope: string, signal?: AbortSignal): Promise<unknown> {
    return this.#request("r_reset", { scope }, signal);
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    try {
      await this.#request("close", {});
    } catch {
      // The worker may have exited after accepting close.
    }
    await this.#terminate(child, "closed");
    this.#workerStatus = "stopped";
    this.#state = { duckdb: "idle", r: "idle" };
  }

  async #request(
    operation: ScienceOperation,
    fields: Omit<ScienceRequest, "id" | "operation">,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) throw abortError(signal);
    await this.#ensureStarted();
    const child = this.#child;
    if (child === undefined || child.connected !== true) {
      throw new Error("Science worker is not connected");
    }

    const id = randomUUID();
    const request: ScienceRequest = { id, operation, ...fields };
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        void this.#terminate(child, "aborted");
        reject(abortError(signal));
      };
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      child.send(request, (error) => {
        if (error === null) return;
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }

  async #ensureStarted(): Promise<void> {
    if (this.#workerStatus === "ready") return;
    if (this.#startPromise !== undefined) return this.#startPromise;
    this.#startPromise = this.#start();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async #start(): Promise<void> {
    await mkdir(dirname(this.#databasePath), { recursive: true });
    this.#workerStatus = "starting";
    this.#stderr = "";
    const child = fork(fileURLToPath(this.#workerUrl), [], {
      env: { ...process.env, PI_BIO_SCIENCE_DB: this.#databasePath },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.#child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-16_000);
    });
    child.on("message", (message: ScienceWorkerMessage) => this.#onMessage(message));
    child.on("exit", (code, signal) => this.#onExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Science worker did not start within ${this.#startupTimeoutMs} ms`));
        }, this.#startupTimeoutMs);
        const check = (message: ScienceWorkerMessage): void => {
          if (message.type !== "ready") return;
          clearTimeout(timer);
          child.off("message", check);
          resolve();
        };
        child.on("message", check);
        child.once("exit", () => {
          clearTimeout(timer);
          child.off("message", check);
          reject(new Error(this.#workerFailure("Science worker exited during startup")));
        });
      });
    } catch (error) {
      await this.#terminate(child, "failed during startup");
      this.#workerStatus = "failed";
      throw error;
    }
  }

  #onMessage(message: ScienceWorkerMessage): void {
    this.#state = message.state;
    if (message.type === "ready") {
      this.#workerStatus = "ready";
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(new Error(message.error ?? "Science worker request failed"));
  }

  #onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    if (this.#workerStatus !== "stopped") this.#workerStatus = "failed";
    const error = new Error(
      this.#workerFailure(`Science worker exited (code=${String(code)}, signal=${String(signal)})`),
    );
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #terminate(child: ChildProcess, reason: string): Promise<void> {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#workerStatus = "stopped";
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`Science worker ${reason}`));
    }
    this.#pending.clear();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  #workerFailure(prefix: string): string {
    const detail = this.#stderr.trim();
    return detail.length === 0 ? prefix : `${prefix}: ${detail}`;
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Science operation aborted");
}

export function scienceWorkerUrl(path: string): URL {
  return pathToFileURL(path);
}
