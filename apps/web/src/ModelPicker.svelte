<script lang="ts">
  import { tick } from "svelte";
  import type { ProviderSummary } from "@pi-bio/protocol";
  let { catalog, value, disabled = false, onchange }: { catalog: ProviderSummary[]; value: string; disabled?: boolean; onchange: (key: string) => Promise<void> } = $props();
  let dialog: HTMLDialogElement;
  let search: HTMLInputElement;
  let list: HTMLSelectElement;
  let query = $state("");
  let choice = $state("");
  const models = $derived(catalog.flatMap((provider) => provider.models.map((model) => ({ key: `${provider.id}/${model.id}`, name: model.name, label: `${provider.name} / ${model.name}` }))));
  const current = $derived(models.find((model) => model.key === value));
  const matches = $derived(models.filter((model) => `${model.key} ${model.label}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(b.key === value) - Number(a.key === value)));
  const visible = $derived(matches.slice(0, 100));
  $effect(() => { if (!visible.some((model) => model.key === choice)) choice = visible[0]?.key ?? ""; });

  export function open(): void {
    if (disabled) return;
    query = "";
    choice = value;
    dialog.showModal();
    void tick().then(() => search.focus());
  }
  async function choose(): Promise<void> {
    if (!choice) return;
    await onchange(choice);
    dialog.close();
  }
</script>

<button type="button" class="model-button" {disabled} onclick={open} aria-haspopup="dialog">{current?.name ?? "Choose model"}<span>⌄</span></button>
<dialog bind:this={dialog} class="model-dialog" aria-labelledby="model-title">
  <form onsubmit={(event) => { event.preventDefault(); void choose(); }}>
    <header><h2 id="model-title">Choose a model</h2><button type="button" aria-label="Close model chooser" onclick={() => dialog.close()}>×</button></header>
    <input bind:this={search} bind:value={query} aria-label="Search models and providers" placeholder="Search provider or model…" onkeydown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); list.focus(); } }} />
    <select bind:this={list} bind:value={choice} size="10" aria-label="Matching models" ondblclick={choose} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void choose(); } }}>
      {#each visible as model (model.key)}<option value={model.key}>{model.label}</option>{/each}
    </select>
    <footer><span>{matches.length} models{matches.length > 100 ? " · showing 100; refine your search" : ""}</span><button disabled={!choice}>Use model</button></footer>
  </form>
</dialog>
