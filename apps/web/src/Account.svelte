<script lang="ts">
  import type { AuthStatus, ProviderSummary, LoginRequest } from "@pi-bio/protocol";
  import * as api from "./api.js";
  let { provider, onstatus }: { provider: ProviderSummary | undefined; onstatus: (value: AuthStatus) => void } = $props();
  let status = $state<AuthStatus>();
  let answer = $state("");
  let busy = $state(false);
  let error = $state("");
  let expanded = $state(false);
  let revision = 0;
  let activeAction: number | undefined;
  let pollNow: (() => void) | undefined;
  let promptId: string | undefined;
  $effect(() => {
    const next = status?.prompt?.id;
    if (next !== promptId) { promptId = next; answer = ""; }
  });
  $effect(() => { if (status?.status === "connecting" || status?.status === "error") expanded = true; });

  $effect(() => {
    const id = provider?.id;
    if (!id) return;
    revision++;
    activeAction = undefined;
    busy = false;
    error = "";
    status = undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      if (activeAction !== undefined) return;
      const observed = revision;
      try {
        const value = await api.authStatus(id!);
        if (disposed || observed !== revision || activeAction !== undefined) return;
        status = value;
        onstatus(value);
      } catch (cause) {
        if (!disposed && observed === revision) error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (!disposed && observed === revision && activeAction === undefined) {
          timer = setTimeout(() => void poll(), status?.status === "connecting" ? 700 : 10_000);
        }
      }
    }
    pollNow = () => { clearTimeout(timer); void poll(); };
    pollNow();
    return () => { disposed = true; revision++; activeAction = undefined; pollNow = undefined; clearTimeout(timer); };
  });

  async function act(action: () => Promise<AuthStatus>): Promise<void> {
    if (activeAction !== undefined) return;
    const operation = ++revision;
    activeAction = operation;
    busy = true;
    error = "";
    const id = provider?.id;
    try {
      const value = await action();
      if (provider?.id !== id || revision !== operation) return;
      status = value;
      onstatus(value);
    } catch (cause) {
      if (revision === operation) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (activeAction === operation) { activeAction = undefined; busy = false; pollNow?.(); }
    }
  }
  function signIn(type: LoginRequest["type"]): void {
    if (provider) void act(() => api.login(provider!.id, { type }));
  }
  function reply(value: string): void {
    if (!provider || !status?.prompt) return;
    const id = status.prompt.id;
    answer = "";
    void act(() => api.answerLogin(provider!.id, { promptId: id, value }));
  }
  function safeLink(url: string): string | undefined {
    try { const target = new URL(url); return target.protocol === "https:" || target.protocol === "http:" ? url : undefined; }
    catch { return undefined; }
  }
</script>

{#if provider}
  <details class="account" bind:open={expanded}>
    <summary><span class:connected={status?.status === "connected"} class="account-dot"></span>{provider.name}<span class="account-state">{status?.status === "connected" ? "Connected" : "Account"}</span></summary>
    <div class="account-body">
      {#if status?.status === "connected"}
        <button class="subtle" disabled={busy} onclick={() => act(() => api.logout(provider!.id))}>Sign out</button>
      {:else if status?.status === "connecting"}
        {#if status.event}
          {@const event = status.event}
          {#if event.type === "auth_url"}
            <a href={safeLink(event.url)} target="_blank" rel="noopener noreferrer">Open sign-in page ↗</a>
            {#if event.instructions}<p>{event.instructions}</p>{/if}
          {:else if event.type === "device_code"}
            <code class="device-code">{event.userCode}</code>
            <a href={safeLink(event.verificationUri)} target="_blank" rel="noopener noreferrer">Enter code ↗</a>
          {:else}
            <p>{event.message}</p>
            {#if event.type === "info"}
              {#each event.links ?? [] as link}<a href={safeLink(link.url)} target="_blank" rel="noopener noreferrer">{link.label ?? link.url}</a>{/each}
            {/if}
          {/if}
        {/if}
        {#if status.prompt}
          {@const prompt = status.prompt}
          <p>{prompt.message}</p>
          {#if prompt.type === "select"}
            {#each prompt.options as option}<button disabled={busy} onclick={() => reply(option.id)}>{option.label}</button>{/each}
          {:else}
            <form onsubmit={(event) => { event.preventDefault(); reply(answer); }}>
              <input aria-label={prompt.message} type={prompt.type === "secret" ? "password" : "text"} bind:value={answer} placeholder={prompt.placeholder} autocomplete="off" required />
              <button disabled={busy}>Continue</button>
            </form>
          {/if}
        {/if}
        <button class="subtle" disabled={busy} onclick={() => act(() => api.cancelLogin(provider!.id))}>Cancel sign-in</button>
      {:else}
        {#if status?.message}<p class="message-error">{status.message}</p>{/if}
        {#each provider.methods as method}<button disabled={busy} onclick={() => signIn(method.type)}>{method.name}</button>{/each}
        {#if !provider.methods.length}<p>This provider uses host-managed credentials.</p>{/if}
      {/if}
      {#if error}<p class="message-error" role="alert">{error}</p>{/if}
    </div>
  </details>
{/if}
