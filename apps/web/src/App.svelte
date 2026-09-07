<script lang="ts">
  import { onMount, tick } from "svelte";
  import { reduceLaneSnapshot } from "@earendil-works/pi-agent-core/harness/runtime/reducer";
  import type { AuthStatus, ProviderSummary, SessionSummary } from "@pi-bio/protocol";
  import * as api from "./api.js";
  import { Drafts } from "./drafts.js";
  import Account from "./Account.svelte";
  import Message from "./Message.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import SessionControls from "./SessionControls.svelte";

  let sessions = $state<SessionSummary[]>([]);
  let catalog = $state<ProviderSummary[]>([]);
  let selected = $state<string>();
  let snapshot = $state<api.LaneSnapshot>();
  let auth = $state<AuthStatus>();
  let text = $state("");
  let draftStatus = $state("");
  let error = $state("");
  let submitting = $state(false);
  let managing = $state(false);
  let booting = $state(true);
  let disconnected = $state(false);
  let panel = $state<"overview" | "tree" | "fork">();
  let archivedView = $state(false);
  const archived = $derived(sessions.some((session) => session.id === selected && session.archivedAt !== undefined));
  let modelPicker: { open(): void };
  let thinkingSelect: HTMLSelectElement;
  let commandIndex = $state(0);
  let commandOpen = $state(true);
  const commands = [
    { id: "new", label: "Start a new analysis" },
    { id: "name", label: "Set session display name", hint: "<name>" },
    { id: "fork", label: "Fork from a previous user message" },
    { id: "clone", label: "Duplicate at the current conversation position" },
    { id: "tree", label: "View conversation branches" },
    { id: "session", label: "Show session info and recorded usage" },
    { id: "model", label: "Choose a provider and model", hint: "<provider/model>" },
    { id: "thinking", label: "Set thinking level", hint: "<level>" },
  ];
  const commandOptions = $derived(commandOpen && text.startsWith("/") ? commands.filter((command) => command.id.startsWith(text.slice(1).split(" ")[0] ?? "")) : []);
  let transcript: HTMLDivElement;
  let stickToBottom = true;
  let stream: AbortController | undefined;
  let eventCursor = 0;
  let baselineVersion = 0;
  let disposed = false;
  const drafts = new Drafts(localStorage, api.saveDraft, (id, message) => { if (id === selected) draftStatus = message; });
  const number = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const usage = $derived(snapshot?.stats?.usage);
  const active = $derived(snapshot?.operation != null);
  const provider = $derived(catalog.find((item) => item.id === snapshot?.configuration.model?.provider));
  const thinkingLevels = $derived(provider?.models.find((model) => model.id === snapshot?.configuration.model?.modelId)?.thinkingLevels ?? []);
  const modelKey = $derived(snapshot?.configuration.model ? `${snapshot.configuration.model.provider}/${snapshot.configuration.model.modelId}` : "");
  const connected = $derived(auth?.providerId === provider?.id && auth?.status === "connected");
  const title = $derived(sessions.find((item) => item.id === selected)?.name ?? "New analysis");
  const failed = $derived(!active && (snapshot?.faulted || snapshot?.lastResult?.status === "failed"));

  onMount(() => {
    void initialize();
    return () => { disposed = true; stream?.abort(); };
  });

  async function initialize(): Promise<void> {
    try {
      [catalog, sessions] = await Promise.all([api.providers(), api.listSessions()]);
      if (disposed) return;
      if (!sessions.length) sessions = [await api.createSession()];
      const previous = localStorage.getItem("pi-bio.selected-session");
      await selectSession(sessions.find((session) => session.id === previous)?.id ?? sessions[0]!.id);
    } catch (cause) { showError(cause); }
    finally { booting = false; }
  }

  async function selectSession(id: string): Promise<void> {
    if (disposed || submitting || managing) return;
    const controller = new AbortController();
    try {
      if (selected) void drafts.flush(selected);
      stream?.abort();
      stream = controller;
      baselineVersion++;
      eventCursor = 0;
      selected = id;
      snapshot = undefined;
      auth = undefined;
      text = "";
      error = "";
      draftStatus = "";
      localStorage.setItem("pi-bio.selected-session", id);
      const value = await api.getSnapshot(id, controller.signal);
      if (stream !== controller || controller.signal.aborted || disposed) return;
      snapshot = value;
      eventCursor = value.eventCursor;
      text = drafts.restore(id, value.draft ?? "");
      draftStatus = text ? "Draft restored" : "";
      if (text !== (value.draft ?? "")) drafts.change(id, text);
      stickToBottom = true;
      await scrollDown();
      void keepStreaming(id, controller.signal);
    } catch (cause) { if (!controller.signal.aborted) showError(cause); }
  }

  async function newSession(): Promise<void> {
    await manage(async () => {
      const session = await api.createSession();
      await loadList(false);
      return session.id;
    });
  }

  async function keepStreaming(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await api.streamEvents(id, (record) => {
          if (selected !== id || stream?.signal !== signal || signal.aborted) return;
          disconnected = false;
          const event = record.event;
          if (event.type === "snapshot") {
            baselineVersion++;
            snapshot = event.snapshot;
          } else {
            if (record.sequence <= eventCursor || !snapshot) return;
            if (event.type === "application_error") error = event.message;
            else reduceLaneSnapshot(snapshot, event);
          }
          eventCursor = record.sequence;
          if (snapshot) snapshot.eventCursor = eventCursor;
          void scrollDown();
        }, signal);
        if (!signal.aborted) disconnected = true;
      } catch (cause) {
        if (signal.aborted) return;
        disconnected = true;
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1_000);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  async function refresh(id: string): Promise<void> {
    const controller = stream;
    const version = baselineVersion;
    try {
      const value = await api.getSnapshot(id, controller?.signal);
      if (selected !== id || stream !== controller || disposed || version !== baselineVersion || value.eventCursor < eventCursor) return;
      snapshot = value;
      eventCursor = value.eventCursor;
      await scrollDown();
    } catch (cause) { if (!controller?.signal.aborted) showError(cause); }
  }
  async function scrollDown(): Promise<void> {
    await tick();
    if (stickToBottom && transcript) transcript.scrollTop = transcript.scrollHeight;
  }
  function changed(): void {
    commandOpen = true;
    commandIndex = 0;
    if (selected) {
      try { drafts.change(selected, text); }
      catch (cause) { showError(cause); }
    }
  }
  function composerKey(event: KeyboardEvent): void {
    if (event.key === "Tab" && event.shiftKey && thinkingLevels.length > 1 && !active && !submitting && !managing && !archived) {
      event.preventDefault();
      const index = thinkingLevels.indexOf(snapshot?.configuration?.thinkingLevel as typeof thinkingLevels[number]);
      void changeThinking(thinkingLevels[(index + 1) % thinkingLevels.length]!);
      return;
    }
    if (commandOptions.length && !event.ctrlKey && !event.metaKey) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        commandIndex = (commandIndex + (event.key === "ArrowDown" ? 1 : -1) + commandOptions.length) % commandOptions.length;
        void tick().then(() => document.getElementById(`slash-option-${commandIndex}`)?.scrollIntoView({ block: "nearest" }));
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        text = `/${commandOptions[commandIndex]!.id} `;
        changed();
        commandOpen = false;
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void runCommand(text.includes(" ") ? text : `/${commandOptions[commandIndex]!.id}`);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); commandOpen = false; return; }
    }
    if (event.key === "Escape" && active) { event.preventDefault(); void stop(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
  }

  async function send(): Promise<void> {
    if (submitting || managing) return;
    if (text.startsWith("/")) { await runCommand(text); return; }
    if (!selected || !snapshot || !text.trim() || active || submitting || !connected || archived) return;
    const id = selected;
    submitting = true;
    error = "";
    try {
      if (!await drafts.flush(id)) throw new Error("Draft could not be saved. Check the connection and try again.");
      await api.sendPrompt(id, text.trim());
      text = "";
      drafts.change(id, "");
      await drafts.flush(id);
      stickToBottom = true;
      await refresh(id);
      sessions = await api.listSessions();
    } catch (cause) { showError(cause); }
    finally { submitting = false; }
  }
  async function manage(action: () => Promise<string | void>): Promise<void> {
    if (submitting || managing) return;
    managing = true;
    let next: string | void = undefined;
    try { next = await action(); }
    catch (cause) { showError(cause); }
    finally { managing = false; }
    if (typeof next === "string") await selectSession(next);
  }
  async function loadList(showArchived: boolean): Promise<string | undefined> {
    const rows = await api.listSessions(showArchived);
    archivedView = showArchived;
    sessions = rows;
    panel = undefined;
    if (!rows.length) { stream?.abort(); selected = undefined; snapshot = undefined; text = ""; }
    return rows[0]?.id;
  }
  async function switchList(showArchived: boolean): Promise<void> {
    await manage(() => loadList(showArchived));
  }
  async function archive(): Promise<void> {
    if (!selected || active) return;
    const id = selected;
    await manage(async () => {
      if (!await drafts.flush(id)) throw new Error("Save the draft before archiving.");
      await api.archiveSession(id);
      return loadList(false);
    });
  }
  async function restore(): Promise<void> {
    if (!selected) return;
    const id = selected;
    await manage(async () => { await api.restoreSession(id); await loadList(false); return id; });
  }
  async function rename(name: string): Promise<void> {
    if (!selected) return;
    const id = selected;
    await manage(async () => { await api.renameSession(id, name); await loadList(archivedView); });
  }
  async function fork(entryId?: string): Promise<void> {
    if (!selected || active) return;
    const id = selected;
    await manage(async () => {
      const value = await api.forkSession(id, entryId);
      await loadList(false);
      return value.id;
    });
  }
  async function reload(): Promise<void> {
    if (!selected) return;
    const id = selected;
    await manage(async () => {
      if (!await drafts.flush(id)) throw new Error("Draft could not be saved before reload.");
      await loadList(archivedView);
      return id;
    });
  }
  async function runCommand(input: string): Promise<void> {
    if (submitting || managing) return;
    const owner = stream;
    const [command, ...args] = input.trim().slice(1).split(/\s+/);
    if (!commands.some((item) => item.id === command)) { error = "Unknown command. Choose a command from the list."; return; }
    text = "";
    if (selected) { drafts.change(selected, ""); await drafts.flush(selected); }
    if (stream !== owner || managing || submitting) return;
    switch (command) {
      case "new": await newSession(); break;
      case "name": if (args.length) await rename(args.join(" ")); else panel = "overview"; break;
      case "fork": panel = "fork"; break;
      case "clone": await fork(); break;
      case "tree": panel = "tree"; break;
      case "session": panel = "overview"; break;
      case "model": if (args[0]) await changeModel(args[0]); else modelPicker?.open(); break;
      case "thinking": if (args[0]) await changeThinking(args[0]); else thinkingSelect?.focus(); break;
    }
  }

  async function changeThinking(level: string): Promise<void> {
    if (!selected || active || archived) return;
    const id = selected;
    await manage(async () => { await api.selectThinking(id, level); await refresh(id); });
  }

  async function changeModel(key: string): Promise<void> {
    if (!selected || active) return;
    const id = selected;
    const separator = key.indexOf("/");
    await manage(async () => {
      await api.selectModel(id, { provider: key.slice(0, separator), modelId: key.slice(separator + 1) });
      await refresh(id);
    });
  }
  async function stop(): Promise<void> {
    if (!selected) return;
    try { await api.abortPrompt(selected); await refresh(selected); }
    catch (cause) { showError(cause); }
  }
  function showError(cause: unknown): void { error = cause instanceof Error ? cause.message : String(cause); }
</script>

<div class="app-shell">
  <aside class="sidebar">
    <a class="brand" href="/" aria-label="Pi Bio home"><span class="brand-mark">π</span><span>Pi Bio<small>Research workspace</small></span></a>
    <button class="new-analysis" disabled={submitting || managing || booting} onclick={newSession}><span>+</span> New analysis</button>
    <div class="sidebar-label"><span>{archivedView ? "Archived analyses" : "Your analyses"}</span><button disabled={submitting || managing || booting} onclick={() => switchList(!archivedView)}>{archivedView ? "Active" : "Archived"}</button></div>
    <nav aria-label="Saved analyses">
      {#each sessions as session (session.id)}
        <button class:current={selected === session.id} aria-current={selected === session.id ? "page" : undefined} disabled={submitting || managing} onclick={() => selectSession(session.id)} title={session.name}>
          <strong>{session.name}</strong><small>{new Date(session.modifiedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
        </button>
      {/each}
    </nav>
    <Account {provider} onstatus={(value) => auth = value} />
  </aside>

  <main class="workspace">
    <header class="topbar"><h1>{title}</h1><span class="run-state" class:running={active} class:failed>{disconnected ? "Reconnecting…" : active ? "Working…" : failed ? "Reply failed" : "Saved workspace"}</span><button class="details-button" disabled={!snapshot} onclick={() => panel = panel ? undefined : "overview"}>Session</button></header>
    {#if panel === "fork" && selected && snapshot}<section class="session-controls" aria-label="Choose a fork point"><header><h2>Fork from a message</h2><button aria-label="Close fork chooser" onclick={() => panel = undefined}>×</button></header><p class="scope-note">The new conversation stops before your chosen message, which is restored as an editable draft. Scientific tables are not copied.</p>{#each snapshot.transcript as entry (entry.id)}{#if entry.type === "message" && entry.message.role === "user"}<button class="fork-choice" disabled={active} onclick={() => fork(entry.id)}>{typeof entry.message.content === "string" ? entry.message.content : JSON.stringify(entry.message.content)}</button>{/if}{/each}</section>
    {:else if panel && selected && snapshot}<SessionControls id={selected} name={title} {snapshot} {archived} pending={submitting || managing} treeView={panel === "tree"} onrename={rename} onfork={async () => { panel = "fork"; }} onclone={() => fork()} onreload={reload} onarchive={archive} onrestore={restore} onclose={() => panel = undefined} />{/if}
    <div class="transcript" bind:this={transcript} role="log" aria-label="Conversation" onscroll={() => { stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100; }}>
      {#if !selected}<section class="welcome"><h2>{archivedView ? "No archived analyses" : "Start an analysis"}</h2><p>Use New analysis to begin, or open a saved conversation.</p></section>{/if}
      {#if archived}<div class="run-error">This session is archived. <button onclick={restore}>Restore to continue</button></div>{/if}
      {#if snapshot && !snapshot.transcript.some((entry) => entry.type === "message")}
        <section class="welcome"><span class="welcome-mark">π</span><h2>What would you like to investigate?</h2><p>Explore your data, test an idea, or work through an analysis.<br />Your conversation and saved results stay here.</p></section>
      {/if}
      {#each snapshot?.transcript ?? [] as entry (entry.id)}
        {#if entry.type === "message"}<Message message={entry.message} />{/if}
      {/each}
      {#if snapshot?.operation?.streamingMessage}<Message message={snapshot.operation.streamingMessage} streaming />{/if}
      {#if active}<div class="working" role="status"><span></span>{snapshot?.operation?.runningTools.length ? "Running analysis…" : "Working…"}</div>{/if}
      {#if failed}<section class="run-error" role="alert"><strong>Pi Bio couldn’t complete this reply.</strong><p>You can change the model or retry your message.</p>{#if snapshot?.lastResult?.error}<details><summary>Error details</summary><p>{snapshot.lastResult.error.message}</p></details>{/if}</section>{/if}
    </div>
    <div class="composer-wrap">
      {#if error}<div class="app-error" role="alert">{error}<button aria-label="Dismiss error" onclick={() => error = ""}>×</button></div>{/if}
      {#if commandOptions.length}<div id="slash-commands" class="command-palette" role="listbox" aria-label="Slash commands">{#each commandOptions as command, index}<button id={`slash-option-${index}`} role="option" aria-selected={commandIndex === index} tabindex="-1" disabled={submitting || managing || ((command.id === "fork" || command.id === "clone") && active)} onclick={() => runCommand(`/${command.id}`)}><code>/{command.id}</code><span>{#if command.hint}<small>{command.hint} — </small>{/if}{command.label}</span></button>{/each}</div>{/if}
      <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea aria-label="Message Pi Bio" bind:value={text} oninput={changed} readonly={submitting || managing || !snapshot || archived} rows="3" maxlength="100000" placeholder="Ask a question or describe your analysis…" aria-controls={commandOptions.length ? "slash-commands" : undefined} aria-activedescendant={commandOptions.length ? `slash-option-${commandIndex}` : undefined} aria-autocomplete="list" onkeydown={composerKey}></textarea>
        <div class="composer-actions">
          <ModelPicker bind:this={modelPicker} {catalog} value={modelKey} disabled={active || submitting || managing || !snapshot || archived} onchange={changeModel} />
          {#if active}<button class="send" type="button" onclick={stop}>Stop</button>{:else}<button class="send" disabled={(!connected && !text.startsWith("/")) || submitting || managing || !text.trim() || !snapshot || archived}>Send <span>↑</span></button>{/if}
        </div>
      </form>
      <div class="composer-footer"><button class="usage-footer" title="Recorded token usage and estimated cost, not subscription billing" onclick={() => panel = "overview"}>↑{number.format(usage?.input ?? 0)} ↓{number.format(usage?.output ?? 0)} · {usage?.cost.total ? `$${usage.cost.total.toFixed(4)}` : auth?.authType === "oauth" ? "subscription" : "no price estimate"}</button><span><select class="thinking-select" bind:this={thinkingSelect} aria-label="Thinking level" value={snapshot?.configuration?.thinkingLevel ?? "off"} disabled={active || submitting || managing || archived || !thinkingLevels.length} onchange={(event) => changeThinking(event.currentTarget.value)}>{#each thinkingLevels as level}<option value={level}>{level}</option>{/each}</select> · / commands</span></div>
      <div class="draft-footer" role="status">{draftStatus || (connected ? "" : "Connect the selected provider in the sidebar to begin.")}</div>
    </div>
  </main>
</div>
