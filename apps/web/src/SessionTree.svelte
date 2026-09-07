<script lang="ts">
  import type { SessionTree } from "@pi-bio/protocol";
  import { sessionTree } from "./api.js";
  let { id }: { id: string } = $props();
  let tree = $state<SessionTree>({ entries: [], lanes: [] });
  let error = $state("");
  let loading = $state(false);
  $effect(() => { const current = id; void load(current); });
  const children = $derived.by(() => {
    const ids = new Set(tree.entries.map((entry) => entry.id));
    const result = new Map<string | null, SessionTree["entries"]>();
    for (const entry of [...tree.entries].sort((a, b) => a.seq - b.seq)) {
      const parent = entry.parentId && ids.has(entry.parentId) ? entry.parentId : null;
      result.set(parent, [...(result.get(parent) ?? []), entry]);
    }
    return result;
  });
  async function load(current: string, cursor?: number): Promise<void> {
    loading = true;
    try {
      const value = await sessionTree(current, cursor);
      if (id !== current) return;
      tree = cursor === undefined ? value : { ...value, entries: [...tree.entries, ...value.entries] };
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { loading = false; }
  }
</script>

{#snippet node(entry: SessionTree["entries"][number])}
  <li>
    <details open>
      <summary><span>{entry.label}</span>{#each tree.lanes.filter((lane) => lane.tipId === entry.id) as lane}<small>{lane.name}</small>{/each}</summary>
      {#if children.has(entry.id)}<ul>{#each children.get(entry.id)! as child (child.id)}{@render node(child)}{/each}</ul>{/if}
    </details>
  </li>
{/snippet}

<div class="session-tree">
  <p>Conversation branches. This view does not imply separate copies of your scientific tables.</p>
  {#if tree.nextCursor !== undefined}<button disabled={loading} onclick={() => load(id, tree.nextCursor)}>Load earlier entries</button>{/if}
  <ul>{#each children.get(null) ?? [] as entry (entry.id)}{@render node(entry)}{/each}</ul>
  {#if loading}<p>Loading tree…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</div>
