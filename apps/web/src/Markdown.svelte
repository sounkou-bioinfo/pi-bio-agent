<script lang="ts">
  import { renderMarkdown } from "./markdown.js";
  let { text }: { text: string } = $props();
  const html = $derived(renderMarkdown(text));

  async function copy(event: MouseEvent): Promise<void> {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button.copy-code") : null;
    if (button === null) return;
    const code = button.closest(".code-block")?.querySelector("code");
    if (code === null || code === undefined) return;
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed — select code";
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events (delegates native button clicks, including keyboard activation, from the Markdown renderer) -->
<div class="prose" onclick={copy}>{@html html}</div>
