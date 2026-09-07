<script lang="ts">
  import type { LaneSnapshot } from "./api.js";
  import SessionTree from "./SessionTree.svelte";
  let { id, name, snapshot, archived = false, pending = false, treeView = false, onrename, onfork, onclone, onreload, onarchive, onrestore, onclose }: {
    id: string; name: string; snapshot: LaneSnapshot; archived?: boolean; pending?: boolean; treeView?: boolean;
    onrename: (name: string) => Promise<void>; onfork: () => Promise<void>; onclone: () => Promise<void>;
    onreload: () => Promise<void>; onarchive: () => Promise<void>; onrestore: () => Promise<void>; onclose: () => void;
  } = $props();
  let draftName = $state("");
  let busy = $state(false);
  $effect(() => { draftName = name; });
  const usage = $derived(snapshot.stats?.usage);
  async function rename(): Promise<void> { busy = true; try { await onrename(draftName); } finally { busy = false; } }
</script>

<section class="session-controls" aria-label="Session controls">
  <header><h2>Analysis details</h2><button aria-label="Close analysis details" onclick={onclose}>×</button></header>
  <fieldset disabled={pending}>
  <form onsubmit={(event) => { event.preventDefault(); void rename(); }}><label for="analysis-name">Name</label><div><input id="analysis-name" bind:value={draftName} maxlength="160" required /><button disabled={busy}>Rename</button></div></form>
  <section class="usage"><h3>Recorded usage</h3>
    <dl><div><dt>Total tokens</dt><dd>{(usage?.totalTokens ?? 0).toLocaleString()}</dd></div><div><dt>Input / output</dt><dd>{(usage?.input ?? 0).toLocaleString()} / {(usage?.output ?? 0).toLocaleString()}</dd></div><div><dt>Cache read / write</dt><dd>{(usage?.cacheRead ?? 0).toLocaleString()} / {(usage?.cacheWrite ?? 0).toLocaleString()}</dd></div>{#if usage?.reasoning !== undefined}<div><dt>Reasoning (included in output)</dt><dd>{usage.reasoning.toLocaleString()}</dd></div>{/if}<div><dt>Estimated model cost</dt><dd>{usage?.cost.total ? `$${usage.cost.total.toFixed(6)}` : "No price estimate"}</dd></div></dl>
    <p>Pi’s recorded usage and price estimates—not a subscription invoice or remaining account quota. Forks start a new usage ledger.</p>
  </section>
  <div class="session-buttons"><button disabled={snapshot.operation !== null} onclick={onfork}>Fork from message</button><button disabled={snapshot.operation !== null} onclick={onclone}>Clone session</button><button onclick={onreload}>Reload view</button></div>
  <p class="scope-note">A fork copies conversation history. DuckDB tables remain shared; its R scratch session starts empty.</p>
  {#if archived}<button onclick={onrestore}>Restore session</button>{:else}<button disabled={snapshot.operation !== null} onclick={onarchive}>Archive session</button>{/if}
  <p class="scope-note">Archiving hides this session from the active list. History, drafts, and scientific data are retained.</p>
  <details open={treeView}><summary>Conversation tree</summary><SessionTree {id} /></details>
  </fieldset>
</section>
