<script lang="ts">
  import Markdown from "./Markdown.svelte";
  import type { ChatMessage } from "./api.js";
  let { message, streaming = false }: { message: ChatMessage; streaming?: boolean } = $props();
  const content = $derived("content" in message ? message.content : JSON.stringify(message, null, 2));
  const blocks = $derived((Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) as Array<{ type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }>);
  const text = $derived(typeof content === "string" ? content : blocks.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"));
  const thinking = $derived(blocks.filter((part) => part.type === "thinking").map((part) => part.thinking ?? "").join("\n"));
  const tools = $derived(blocks.filter((part) => part.type === "toolCall"));
  const failed = $derived(message.role === "assistant" && (message.stopReason === "error" || message.errorMessage !== undefined));
  const stopped = $derived(message.role === "assistant" && message.stopReason === "aborted");

  function toolCode(name: string | undefined, args: unknown): string {
    const value = args as { sql?: string; code?: string } | null;
    if (name === "duckdb_sql" && typeof value?.sql === "string") return `\`\`\`sql\n${value.sql}\n\`\`\``;
    if (name === "r_eval" && typeof value?.code === "string") return `\`\`\`r\n${value.code}\n\`\`\``;
    return `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``;
  }
  function resultText(value: string): string {
    try { return `\`\`\`json\n${JSON.stringify(JSON.parse(value), null, 2)}\n\`\`\``; }
    catch { return value; }
  }
</script>

{#if text.trim() || thinking || tools.length || failed || stopped}
  <article class="message" class:user={message.role === "user"} class:assistant={message.role === "assistant"} class:tool-result={message.role === "toolResult"}>
    {#if message.role === "toolResult"}
      <details class="tool-detail">
        <summary>{message.toolName ?? "Tool"} result</summary>
        <Markdown text={resultText(text)} />
      </details>
    {:else}
      <header>{message.role === "user" ? "You" : "Pi Bio"}</header>
      {#each blocks as part}
        {#if part.type === "thinking" && part.thinking}
          <details class="thinking" open>
            <summary>{streaming && !text ? "Thinking…" : "Reasoning"}</summary>
            <Markdown text={part.thinking} />
          </details>
        {:else if part.type === "text" && part.text}
          <Markdown text={part.text} />
        {:else if part.type === "toolCall"}
          <details class="tool-detail" open={streaming}>
            <summary>{part.name ?? "Tool"}</summary>
            <Markdown text={toolCode(part.name, part.arguments)} />
          </details>
        {/if}
      {/each}
    {/if}
    {#if failed || stopped}<p class="message-error">{failed ? "This reply failed." : "Reply stopped."}</p>{/if}
  </article>
{/if}
