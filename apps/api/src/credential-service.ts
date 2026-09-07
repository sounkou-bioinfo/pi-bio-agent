import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels, type AuthPrompt, type Models } from "@earendil-works/pi-ai";
import type { AuthReply, AuthStatus, LoginRequest, ProviderSummary } from "@pi-bio/protocol";

interface Login {
  state: AuthStatus;
  controller: AbortController;
  done?: Promise<void>;
  answer?: (value: string) => void;
}

// Transports Pi's AuthInteraction prompts and notifications to the UI.
export class CredentialService {
  readonly #models: Models;
  #login: Login | undefined;

  constructor(models: Models) { this.#models = models; }

  catalog(): ProviderSummary[] {
    return this.#models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      methods: [
        ...(provider.auth.oauth ? [{ type: "oauth" as const, name: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
        ...(provider.auth.apiKey?.login ? [{ type: "api_key" as const, name: provider.auth.apiKey.name }] : []),
      ],
      models: this.#models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) })),
    }));
  }

  async status(providerId: string): Promise<AuthStatus> {
    if (this.#models.getProvider(providerId) === undefined) throw new Error(`Unknown provider: ${providerId}`);
    if (this.#login?.state.providerId === providerId) return structuredClone(this.#login.state);
    const auth = await this.#models.checkAuth(providerId);
    return { providerId, status: auth === undefined ? "disconnected" : "connected", ...(auth ? { authType: auth.type } : {}) };
  }

  async login(providerId: string, request: LoginRequest): Promise<AuthStatus> {
    if (this.#login?.state.status === "connecting") throw new Error("A sign-in is already in progress");
    const provider = this.#models.getProvider(providerId);
    if (provider === undefined) throw new Error(`Unknown provider: ${providerId}`);
    const flow: Login = {
      state: { providerId, status: "connecting" },
      controller: new AbortController(),
    };
    this.#login = flow;
    flow.done = this.#models.login(providerId, request.type, {
      signal: flow.controller.signal,
      notify: (event) => { flow.state.event = event; },
      prompt: (prompt) => this.#prompt(flow, prompt),
    }).then(() => {
      if (this.#login === flow) this.#login = undefined;
    }).catch((error: unknown) => {
      flow.state = flow.controller.signal.aborted
        ? { providerId, status: "disconnected" }
        : { providerId, status: "error", message: error instanceof Error ? error.message : String(error) };
    });
    return structuredClone(flow.state);
  }

  async answer(providerId: string, reply: AuthReply): Promise<AuthStatus> {
    const flow = this.#login;
    if (flow?.state.providerId !== providerId || flow.state.prompt?.id !== reply.promptId || flow.answer === undefined) {
      throw new Error("This sign-in prompt is no longer active");
    }
    if (flow.state.prompt.type === "select" && !flow.state.prompt.options.some((option) => option.id === reply.value)) {
      throw new Error("Invalid sign-in option");
    }
    flow.answer(reply.value);
    return this.status(providerId);
  }

  async cancel(providerId: string): Promise<AuthStatus> {
    if (this.#login?.state.providerId === providerId) {
      const flow = this.#login;
      flow.controller.abort(new Error("Sign-in cancelled"));
      await flow.done;
      if (this.#login === flow) this.#login = undefined;
    }
    return this.status(providerId);
  }

  async logout(providerId: string): Promise<AuthStatus> {
    await this.cancel(providerId);
    await this.#models.logout(providerId);
    return this.status(providerId);
  }

  async close(): Promise<void> {
    const flow = this.#login;
    flow?.controller.abort(new Error("Application closing"));
    await flow?.done;
  }

  #prompt(flow: Login, prompt: AuthPrompt): Promise<string> {
    const { signal: promptSignal, ...visible } = prompt;
    const signal = AbortSignal.any(promptSignal ? [flow.controller.signal, promptSignal] : [flow.controller.signal]);
    signal.throwIfAborted();
    const id = randomUUID();
    flow.state.prompt = { ...visible, id };
    return new Promise<string>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener("abort", abort);
        delete flow.answer;
        if (flow.state.prompt?.id === id) delete flow.state.prompt;
      };
      const abort = (): void => { cleanup(); reject(signal.reason); };
      flow.answer = (value) => { cleanup(); resolve(value); };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
